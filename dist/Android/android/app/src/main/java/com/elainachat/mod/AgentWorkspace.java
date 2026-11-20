package com.elainachat.mod;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 手机的「文件访问」能力。
 *
 * <p>文件访问分两层：
 *
 * <ol>
 *   <li><b>Agent 工作区</b>（{@code agent-workspace/}，应用私有目录下）——
 *       不需要任何系统权限，AI 可以自由读写。这是默认落脚点，
 *       也是"AI 存点东西"最安全的去处（随应用卸载一起消失，不污染用户存储）。</li>
 *   <li><b>用户选定的文件夹</b> —— 通过系统文件选择器（SAF）授权，拿到一个
 *       **持久化 URI**。AI 可以读写那个文件夹内的文件。随时可在设置里取消。</li>
 * </ol>
 *
 * <p>为什么不做"整个手机存储随便读"：
 *   那需要 {@code MANAGE_EXTERNAL_STORAGE}（所有文件访问权限）。它会被应用商店
 *   直接拒审，对用户来说也是"给了就收不回"的授权。SAF 的粒度是"一个文件夹"，
 *   用户可以精确控制给哪个目录、也能随时收回 —— 代价只是多一次选择操作。
 *
 * <p>路径规则（AI 只需要懂这一条）：
 *   传**相对路径** → 在 Agent 工作区里操作；传 {@code saf:<相对路径>} → 在用户
 *   授权的文件夹里操作。{@code saf:} 前缀由前端在"用户已授权文件夹"时按用户意图
 *   加上（见 web/js/app-03-agent.js 的 phoneFilePath），AI 不必自己拼。
 */
final class AgentWorkspace {

    /** 工作区目录名（应用私有目录下） */
    private static final String WORKSPACE_DIR = "agent-workspace";

    /** 授权文件夹里"走 SAF"的路径前缀 */
    static final String SAF_PREFIX = "saf:";

    /** 单次读取上限：与电脑端 AGENT_READ_LIMIT 保持一致（300KB） */
    private static final int READ_LIMIT = 300 * 1024;

    /** 单次写入上限（1MB），防止 AI 一次写爆存储 */
    private static final int WRITE_LIMIT = 1024 * 1024;

    static final String PREFS = "elainachat_open_shell";
    private static final String KEY_FOLDER_URI = "agent_folder_uri";
    private static final String KEY_FOLDER_NAME = "agent_folder_name";

    private final Context context;

    AgentWorkspace(Context context) {
        this.context = context;
    }

    /** 这个动作归本类管吗 */
    static boolean handles(String action) {
        switch (action) {
            case "手机列出文件":
            case "手机读文件":
            case "手机写文件":
            case "手机删除文件":
                return true;
            default:
                return false;
        }
    }

    JSObject run(String action, String args) {
        try {
            switch (action) {
                case "手机列出文件": return success(listFiles(args));
                case "手机读文件": return success(readFile(args));
                case "手机写文件": return success(writeFile(args));
                case "手机删除文件": return success(deleteFile(args));
                default: return failure("不支持的文件动作：" + action);
            }
        } catch (SecurityException error) {
            return failure(String.valueOf(error.getMessage()));
        } catch (Throwable error) {
            return failure("文件操作失败：" + ShellProcess.describe(error));
        }
    }

    // 工作区

    private File workspaceRoot() {
        File base = context.getExternalFilesDir(null);
        if (base == null) base = context.getFilesDir();
        File dir = new File(base, WORKSPACE_DIR);
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    /**
     * 解析工作区内的相对路径。
     *
     * <p>{@code ..} 一律拒绝：这是防目录穿越，必须在解析前拦掉，
     * 因为 {@code getCanonicalPath} 对不存在的路径不可靠。
     * 解析后再用规范路径二次确认仍在工作区内（防符号链接绕过）。
     */
    private File resolveInWorkspace(String rawPath) throws Exception {
        String rel = cleanRelative(rawPath);
        File root = workspaceRoot();
        if (rel.isEmpty()) return root;
        for (String part : rel.split("/")) {
            if ("..".equals(part)) throw new SecurityException("路径里不允许出现「..」");
        }
        File target = new File(root, rel);
        String rootPath = root.getCanonicalPath();
        String targetPath = target.getCanonicalPath();
        if (!targetPath.equals(rootPath) && !targetPath.startsWith(rootPath + File.separator)) {
            throw new SecurityException("只能在工作区内操作");
        }
        return target;
    }

    // 授权文件夹（SAF）

    private Uri authorizedTreeUri() {
        String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_FOLDER_URI, "");
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            return Uri.parse(raw.trim());
        } catch (Throwable error) {
            return null;
        }
    }

    /**
     * 把 {@code saf:a/b.txt} 这样的路径解析成授权文件夹里的真实 document URI。
     *
     * <p>逐段用 {@link DocumentsContract#buildChildDocumentsUriUsingTree} 往下走，
     * 而不是"拼字符串" —— SAF 的 document id 是系统给的、不透明，
     * 拼出来的 URI 在多数设备上直接查不到。
     *
     * @param rel 相对路径（已剥掉 {@code saf:} 前缀）
     * @param createParents 中间目录不存在时要不要创建（写文件时为 true）
     * @return 目标 document 的 URI；{@code root} 表示就是根目录本身
     */
    private Uri resolveInAuthorizedFolder(String rel, boolean createParents) throws Exception {
        Uri tree = authorizedTreeUri();
        if (tree == null) {
            throw new SecurityException("还没有授权任何文件夹。请到「设置 → 能力 → 手机操作 → 文件访问」点「选择文件夹授权」。");
        }
        String rootDocId = DocumentsContract.getTreeDocumentId(tree);
        Uri current = DocumentsContract.buildDocumentUriUsingTree(tree, rootDocId);
        String clean = cleanRelative(rel);
        if (clean.isEmpty()) return current;

        String[] parts = clean.split("/");
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty() || ".".equals(part)) continue;
            if ("..".equals(part)) throw new SecurityException("路径里不允许出现「..」");
            boolean isLast = (i == parts.length - 1);
            Uri child = findChild(tree, current, part);
            if (child == null) {
                if (!createParents && !isLast) {
                    throw new SecurityException("目录不存在：" + clean);
                }
                if (isLast && !createParents) {
                    // 读/删不创建，交给调用方报"不存在"
                    return null;
                }
                // 写文件时把中间目录建出来
                child = DocumentsContract.createDocument(
                    context.getContentResolver(), current,
                    DocumentsContract.Document.MIME_TYPE_DIR, part);
                if (child == null) throw new SecurityException("创建目录失败：" + part);
            }
            current = child;
        }
        return current;
    }

    /** 在 parent 下按显示名找一个子项；找不到返回 null */
    private Uri findChild(Uri tree, Uri parent, String name) {
        String parentId = DocumentsContract.getDocumentId(parent);
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor cursor = context.getContentResolver().query(
                childrenUri,
                new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME
                },
                null, null, null)) {
            if (cursor == null) return null;
            while (cursor.moveToNext()) {
                String display = cursor.getString(1);
                if (name.equals(display)) {
                    return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
                }
            }
        } catch (Throwable error) {
            // 查询失败按"没找到"处理，调用方会给出可读的失败原因
        }
        return null;
    }

    /** 读一个 document 的显示名（失败返回 null） */
    private String displayNameOf(Uri doc) {
        try (Cursor cursor = context.getContentResolver().query(
                doc,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Throwable error) {
            // 忽略：只是显示名
        }
        return null;
    }

    private boolean isDirectory(Uri doc) {
        try (Cursor cursor = context.getContentResolver().query(
                doc,
                new String[]{DocumentsContract.Document.COLUMN_MIME_TYPE},
                null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                return DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(0));
            }
        } catch (Throwable error) {
            // 忽略
        }
        return false;
    }

    // 列出

    private String listFiles(String args) {
        String raw = String.valueOf(args == null ? "" : args).trim();
        if (raw.startsWith(SAF_PREFIX)) return listAuthorized(raw.substring(SAF_PREFIX.length()));
        try {
            File target = resolveInWorkspace(raw);
            if (!target.exists()) {
                return "路径不存在：" + describeWorkspacePath(raw)
                    + "\n（可以先用 [操作:手机列出文件] 看看工作区根目录里有什么。）";
            }
            if (target.isFile()) return "这是一个文件（不是目录）：" + describeWorkspacePath(raw);
            File[] children = target.listFiles();
            if (children == null || children.length == 0) return "目录是空的：" + describeWorkspacePath(raw);
            List<String> lines = new ArrayList<>();
            for (File child : children) {
                lines.add((child.isDirectory() ? "📁 " : "📄 ") + child.getName()
                    + (child.isFile() ? "（" + child.length() + " 字节）" : ""));
            }
            lines.sort(String::compareTo);
            return "目录内容（" + describeWorkspacePath(raw) + "）：\n" + String.join("\n", lines);
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "列出失败：" + ShellProcess.describe(error);
        }
    }

    private String listAuthorized(String rel) {
        try {
            Uri tree = authorizedTreeUri();
            if (tree == null) return noFolderMessage();
            Uri target = resolveInAuthorizedFolder(rel, false);
            if (target == null) return "路径不存在：" + describeFolderPath(rel);
            if (!isDirectory(target)) return "这是一个文件（不是目录）：" + describeFolderPath(rel);
            String docId = DocumentsContract.getDocumentId(target);
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
            List<String> lines = new ArrayList<>();
            try (Cursor cursor = context.getContentResolver().query(
                    childrenUri,
                    new String[]{
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE
                    },
                    null, null, null)) {
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        String name = cursor.getString(0);
                        boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1));
                        long size = cursor.isNull(2) ? 0 : cursor.getLong(2);
                        lines.add((dir ? "📁 " : "📄 ") + name + (!dir ? "（" + size + " 字节）" : ""));
                    }
                }
            }
            if (lines.isEmpty()) return "目录是空的：" + describeFolderPath(rel);
            lines.sort(String::compareTo);
            return "目录内容（" + describeFolderPath(rel) + "）：\n" + String.join("\n", lines);
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "列出失败：" + ShellProcess.describe(error);
        }
    }

    // 读

    private String readFile(String args) {
        String raw = String.valueOf(args == null ? "" : args).trim();
        if (raw.isEmpty()) return "请给出要读取的文件路径。";
        if (raw.startsWith(SAF_PREFIX)) return readAuthorized(raw.substring(SAF_PREFIX.length()));
        try {
            File target = resolveInWorkspace(raw);
            if (!target.exists()) return "文件不存在：" + describeWorkspacePath(raw);
            if (target.isDirectory()) return "那是一个目录，不是文件：" + describeWorkspacePath(raw);
            if (target.length() > READ_LIMIT) {
                return "文件太大（" + target.length() + " 字节，上限 " + READ_LIMIT + "）";
            }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(new FileInputStream(target), StandardCharsets.UTF_8))) {
                char[] buf = new char[8192];
                int n;
                while ((n = reader.read(buf)) > 0) sb.append(buf, 0, n);
            }
            return "文件内容（" + describeWorkspacePath(raw) + "）：\n" + sb;
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "读取失败：" + ShellProcess.describe(error);
        }
    }

    private String readAuthorized(String rel) {
        try {
            if (authorizedTreeUri() == null) return noFolderMessage();
            Uri target = resolveInAuthorizedFolder(rel, false);
            if (target == null) return "文件不存在：" + describeFolderPath(rel);
            if (isDirectory(target)) return "那是一个目录，不是文件：" + describeFolderPath(rel);
            StringBuilder sb = new StringBuilder();
            try (InputStream in = context.getContentResolver().openInputStream(target)) {
                if (in == null) return "打不开这个文件（可能已被删除或没有权限）。";
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                    char[] buf = new char[8192];
                    int n;
                    int total = 0;
                    while ((n = reader.read(buf)) > 0) {
                        sb.append(buf, 0, n);
                        total += n;
                        if (total > READ_LIMIT) {
                            sb.append("\n…（已截断，文件超过 ").append(READ_LIMIT).append(" 字节）");
                            break;
                        }
                    }
                }
            }
            return "文件内容（" + describeFolderPath(rel) + "）：\n" + sb;
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "读取失败：" + ShellProcess.describe(error);
        }
    }

    // 写

    /**
     * 写入。AI 的写法是 {@code [操作:手机写文件 路径|内容]}，
     * 所以按**第一个** {@code |} 拆开（与电脑端同一套约定）。
     */
    private String writeFile(String args) {
        String raw = String.valueOf(args == null ? "" : args).trim();
        int sep = raw.indexOf('|');
        if (sep < 0) {
            return "写法不对。请用 [操作:手机写文件 路径|内容] —— 路径与内容之间要有一个 | 分隔。";
        }
        String path = raw.substring(0, sep).trim();
        String content = raw.substring(sep + 1);
        if (path.isEmpty()) return "没有给出要写入的路径。";
        if (content.length() > WRITE_LIMIT) {
            return "内容太大（" + content.length() + " 字符，上限 " + WRITE_LIMIT + "）";
        }
        if (path.startsWith(SAF_PREFIX)) return writeAuthorized(path.substring(SAF_PREFIX.length()), content);
        try {
            File target = resolveInWorkspace(path);
            if (target.isDirectory()) return "那是一个目录，不能写入：" + describeWorkspacePath(path);
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory()) parent.mkdirs();
            try (OutputStreamWriter writer = new OutputStreamWriter(
                    new FileOutputStream(target), StandardCharsets.UTF_8)) {
                writer.write(content);
            }
            return "✅ 已写入：" + describeWorkspacePath(path) + "（" + content.length() + " 字符）";
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "写入失败：" + ShellProcess.describe(error);
        }
    }

    private String writeAuthorized(String rel, String content) {
        try {
            Uri tree = authorizedTreeUri();
            if (tree == null) return noFolderMessage();
            String clean = cleanRelative(rel);
            if (clean.isEmpty()) return "请给出要写入的文件名，不能直接写文件夹本身。";

            // 先找目标文件；不存在就（必要时连中间目录一起）建出来
            Uri target = resolveInAuthorizedFolder(clean, false);
            if (target == null) {
                target = createDocumentWithParents(tree, clean);
            }
            if (target == null) return "无法在授权文件夹里创建这个文件：" + clean;
            if (isDirectory(target)) return "那是一个目录，不能写入：" + describeFolderPath(clean);

            try (OutputStream out = context.getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) return "打不开这个文件用于写入。";
                out.write(content.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
            return "✅ 已写入：" + describeFolderPath(clean) + "（" + content.length() + " 字符）";
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "写入失败：" + ShellProcess.describe(error);
        }
    }

    /** 建文件，必要时把中间目录逐级建出来 */
    private Uri createDocumentWithParents(Uri tree, String rel) throws Exception {
        String rootDocId = DocumentsContract.getTreeDocumentId(tree);
        Uri current = DocumentsContract.buildDocumentUriUsingTree(tree, rootDocId);
        String[] parts = rel.split("/");
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty() || ".".equals(part)) continue;
            boolean isLast = (i == parts.length - 1);
            Uri child = findChild(tree, current, part);
            if (child == null) {
                String mime = isLast ? guessMime(part) : DocumentsContract.Document.MIME_TYPE_DIR;
                child = DocumentsContract.createDocument(
                    context.getContentResolver(), current, mime, part);
                if (child == null) return null;
            }
            current = child;
        }
        return current;
    }

    // 删

    private String deleteFile(String args) {
        String raw = String.valueOf(args == null ? "" : args).trim();
        if (raw.isEmpty()) return "请给出要删除的路径。";
        if (raw.startsWith(SAF_PREFIX)) return deleteAuthorized(raw.substring(SAF_PREFIX.length()));
        try {
            File target = resolveInWorkspace(raw);
            if (!target.exists()) return "要删除的东西不存在：" + describeWorkspacePath(raw);
            boolean isDir = target.isDirectory();
            if (!deleteRecursively(target)) return "删除失败（可能被占用）：" + describeWorkspacePath(raw);
            return "🗑️ 已删除" + (isDir ? "目录" : "文件") + "：" + describeWorkspacePath(raw);
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "删除失败：" + ShellProcess.describe(error);
        }
    }

    private String deleteAuthorized(String rel) {
        try {
            if (authorizedTreeUri() == null) return noFolderMessage();
            String clean = cleanRelative(rel);
            if (clean.isEmpty()) return "不能删除授权的文件夹本身。";
            Uri target = resolveInAuthorizedFolder(clean, false);
            if (target == null) return "要删除的东西不存在：" + describeFolderPath(clean);
            boolean isDir = isDirectory(target);
            boolean ok = DocumentsContract.deleteDocument(context.getContentResolver(), target);
            if (!ok) return "删除失败（可能被占用）：" + describeFolderPath(clean);
            return "🗑️ 已删除" + (isDir ? "目录" : "文件") + "：" + describeFolderPath(clean);
        } catch (SecurityException error) {
            return String.valueOf(error.getMessage());
        } catch (Throwable error) {
            return "删除失败：" + ShellProcess.describe(error);
        }
    }

    private boolean deleteRecursively(File target) {
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        return target.delete();
    }

    // 工具

    private static String cleanRelative(String rawPath) {
        String rel = String.valueOf(rawPath == null ? "" : rawPath).trim().replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel;
    }

    /** 给用户/模型看的路径描述（带"工作区"语义，避免它以为是绝对路径） */
    private String describeWorkspacePath(String rel) {
        String clean = cleanRelative(rel);
        return clean.isEmpty() ? "工作区根目录" : ("工作区/" + clean);
    }

    private String describeFolderPath(String rel) {
        String clean = cleanRelative(rel);
        String name = authorizedFolderName(context);
        if (name.isEmpty()) name = "已授权文件夹";
        return clean.isEmpty() ? name : (name + "/" + clean);
    }

    private String noFolderMessage() {
        return "还没有授权任何文件夹。请到「设置 → 能力 → 手机操作 → 文件访问」点「选择文件夹授权」。"
            + "（不授权也能用：AI 可以在 Agent 工作区里读写文件。）";
    }

    /** 按扩展名猜 MIME。猜不出用 octet-stream（SAF 建文件时需要一个类型）。 */
    private static String guessMime(String name) {
        String lower = String.valueOf(name).toLowerCase(java.util.Locale.ROOT);
        if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".csv")) return "text/csv";
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    // 授权文件夹的存取（供插件方法调用）

    static void saveAuthorizedFolder(Context context, Uri uri, String name) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_FOLDER_URI, uri == null ? "" : uri.toString())
            .putString(KEY_FOLDER_NAME, name == null ? "" : name)
            .apply();
    }

    static void clearAuthorizedFolder(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_FOLDER_URI)
            .remove(KEY_FOLDER_NAME)
            .apply();
    }

    static String authorizedFolderUri(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_FOLDER_URI, "");
    }

    static String authorizedFolderName(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_FOLDER_NAME, "");
    }

    /** 工作区里现有的文件数（设置页显示用） */
    static int workspaceFileCount(Context context) {
        try {
            File base = context.getExternalFilesDir(null);
            if (base == null) base = context.getFilesDir();
            File dir = new File(base, WORKSPACE_DIR);
            if (!dir.isDirectory()) return 0;
            File[] children = dir.listFiles();
            return children == null ? 0 : children.length;
        } catch (Throwable error) {
            return 0;
        }
    }

    private static JSObject success(String text) {
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("text", text);
        out.put("backend", "local");
        return out;
    }

    private static JSObject failure(String text) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("text", text);
        return out;
    }
}
