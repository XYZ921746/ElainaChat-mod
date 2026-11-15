package com.elainachat.mod;

import java.util.Locale;

/**
 * 把「[操作:手机xxx …]」翻译成 shell 命令。
 *
 * <p>只构造命令，不执行 —— ★ 2026-10 起只剩「模块」一个命令族后端用它
 * （Shizuku / Root 已删除，无障碍后端不走这里）。
 */
final class PhoneCommand {

    private PhoneCommand() {}

    /** 返回 null 表示这个动作不该走命令族（比如"等待"，或者中文输入）。 */
    static String build(String action, String args, String scratchDir) {
        return build(action, args, scratchDir, false);
    }

    /**
     * @param forModule 是否在为 agent-mobile-use 模块后端构造命令。
     *
     * <p>为什么需要单独一条：模块的价值是**独立虚拟副屏**（Display 2/3），
     * 所有操作必须**定向到那个屏**才有效。而通用命令族发的是裸 {@code input tap x y} ——
     * 不带 {@code -d <did>} 就作用于默认屏（主屏），副屏根本收不到，
     * 表现就是"模块在跑、点击没反应"。模块自带 {@code vd} 工具专门做这件事
     * （内部用 {@code input -d <did>}），所以这里改用 vd 子命令。
     *
     * <p>vd 的全路径：模块会把 system/bin/vd 挂到 /system/bin（KernelSU overlay），
     * 但实测某些环境挂载没生效，所以两个路径都试。
     */
    static String build(String action, String args, String scratchDir, boolean forModule) {
        String a = args == null ? "" : args.trim();
        if (forModule) {
            String vd = moduleVdCommand();
            switch (action) {
                case "手机状态": {
                    // 模块的状态要看副屏，而不是主屏。
                    // `vd status` 如今直接回 /api/status 的 JSON（不再有 --json 开关），
                    // 所以只能问一次，再补上主屏规格供对照。
                    return vd + " status 2>&1; echo ---; wm size; wm density";
                }
                case "手机截图":
                    // 实际不会走到这里：ElainaShellPlugin 对模块后端的截图**先**走
                    // GET /api/screenshot（HTTP，直接返回当前目标屏的 JPEG）。
                    // 这里留个兜底 —— 注意 `vd screenshot` 现在写的是 JPEG，
                    // 文件名必须跟着用 .jpg，否则下游按后缀解析就会认错格式。
                    return vd + " screenshot " + quote(scratchDir + "/shot.jpg") + " 2>&1; "
                        + "chmod 666 " + quote(scratchDir + "/shot.jpg") + " 2>/dev/null";
                case "手机查看界面":
                    // 同上：优先走 GET /api/dump_ui，这里兜底用 vd tree。
                    return vd + " tree 2>&1";
                case "手机点击": {
                    int[] p = ints(a, 2);
                    if (p == null) return null;
                    return vd + " tap " + p[0] + " " + p[1];
                }
                case "手机滑动": {
                    int[] p = ints(a, 4);
                    if (p == null) return null;
                    int duration = 300;
                    String[] parts = a.split("\\s+");
                    if (parts.length >= 5) {
                        try {
                            duration = Math.max(40, Math.min(8000, Integer.parseInt(parts[4])));
                        } catch (NumberFormatException ignored) { /* 默认时长 */ }
                    }
                    return vd + " swipe " + p[0] + " " + p[1] + " " + p[2] + " " + p[3] + " " + duration;
                }
                case "手机按键": {
                    Integer code = keyCode(a);
                    if (code == null) return null;
                    return vd + " key " + code;
                }
                case "手机打开": {
                    if (a.isEmpty()) return null;
                    // vd launch 把应用定向启动到副屏
                    return vd + " launch " + quote(a);
                }
                case "手机输入": {
                    // vd set_value 是模块 0.6.0 起的静默注入子命令（原名 `vd type`，
                    // 改名时同时要求显式 target，并删掉了"焦点模式"这套猜测逻辑）。
                    // 省略 target 等于 focused，即模块自己找当前聚焦的输入框 ——
                    // 不点屏幕、不碰剪贴板，中文与特殊符号都能进。
                    if (a.isEmpty()) return null;
                    return vd + " set_value " + quote(a);
                }
                case "手机命令":
                    return a.isEmpty() ? null : a;
                default:
                    return null;
            }
        }
        switch (action) {
            case "手机状态":
                return "wm size; wm density; getprop ro.product.model; "
                    + "getprop ro.build.version.release; "
                    + "dumpsys window windows 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'";
            case "手机截图":
                return "screencap -p " + quote(scratchDir + "/shot.png")
                    + " && chmod 666 " + quote(scratchDir + "/shot.png");
            case "手机查看界面":
                return "uiautomator dump " + quote(scratchDir + "/ui.xml")
                    + " && chmod 666 " + quote(scratchDir + "/ui.xml");
            case "手机点击": {
                int[] p = ints(a, 2);
                if (p == null) return null;
                return "input tap " + p[0] + " " + p[1];
            }
            case "手机滑动": {
                int[] p = ints(a, 4);
                if (p == null) return null;
                int duration = 300;
                String[] parts = a.split("\\s+");
                if (parts.length >= 5) {
                    try {
                        duration = Math.max(40, Math.min(8000, Integer.parseInt(parts[4])));
                    } catch (NumberFormatException ignored) {
                        // 用默认时长
                    }
                }
                return "input swipe " + p[0] + " " + p[1] + " " + p[2] + " " + p[3] + " " + duration;
            }
            case "手机按键": {
                Integer code = keyCode(a);
                if (code == null) return null;
                return "input keyevent " + code;
            }
            case "手机打开": {
                if (a.isEmpty()) return null;
                if (a.contains("/")) return "am start -n " + quote(a);
                return "monkey -p " + quote(a) + " -c android.intent.category.LAUNCHER 1";
            }
            case "手机输入": {
                // 只走 ASCII。中文走无障碍的 ACTION_SET_TEXT —— input text 用的是
                // KeyCharacterMap 的虚拟键盘映射，非 ASCII 字符根本映射不出按键事件。
                if (!isAsciiOnly(a)) return null;
                if (a.isEmpty()) return null;
                return "input text " + quote(a.replace(" ", "%s"));
            }
            case "手机命令":
                return a.isEmpty() ? null : a;
            default:
                return null;
        }
    }

    /**
     * 模块 vd 工具的调用前缀（后面直接拼子命令，如 {@code <prefix> tap 800 400}）。
     *
     * <p>优先用 PATH 里的 {@code vd}（模块会把 system/bin/vd 挂到 /system/bin），
     * 挂载没生效时退到模块目录里的绝对路径 —— 实测某些环境下 overlay 不生效
     * （{@code mount} 里看不到模块条目，{@code /system/bin/vd} 不存在），
     * 但模块目录里的那份始终在。
     *
     * <p>写法要点：解析成一个变量再用 {@code "$VD"} 调用。
     * <b>不能写成 {@code (cmd1 && cmd2 || cmd3) sub}</b> —— 子 shell 右括号后面
     * 直接跟参数是语法错误（实测报 {@code syntax error: unexpected 'tap'}）。
     * 而 {@code VD=$(...); "$VD" tap ...} 是合法的命令列表，且外层无论走
     * {@code su -c} 还是模块的 {@code sh -c} 都能正确解析。
     */
    private static String moduleVdCommand() {
        return "VD=$(command -v vd 2>/dev/null || echo /data/adb/modules/agent_mobile_use/system/bin/vd); \"$VD\"";
    }

    /** 「等等」这类不用发命令的动作，由调用方单独处理。 */
    static boolean isLocalOnly(String action) {
        return "手机等待".equals(action);
    }

    static boolean isAsciiOnly(String text) {
        if (text == null) return true;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) > 0x7F) return false;
        }
        return true;
    }

    /** 解析出 n 个整数；数量不够或不是数字就返回 null。 */
    /** 供模块端点路由复用（与 ints 同义，名字更明确）。 */
    static int[] parseInts(String args, int n) { return ints(args, n); }

    /** 供模块端点路由复用。 */
    static Integer keyCodeFor(String key) { return keyCode(key); }

    static int[] ints(String args, int n) {
        if (args == null || args.trim().isEmpty()) return null;
        String[] parts = args.trim().split("\\s+");
        if (parts.length < n) return null;
        int[] values = new int[n];
        for (int i = 0; i < n; i++) {
            try {
                values[i] = Math.round(Float.parseFloat(parts[i]));
            } catch (NumberFormatException error) {
                return null;
            }
        }
        return values;
    }

    /** 把中文/英文键名映射成 keycode。也允许用户直接写数字。 */
    static Integer keyCode(String key) {
        String k = key.toLowerCase(Locale.ROOT).trim();
        switch (k) {
            case "返回": case "back": return 4;
            case "主页": case "桌面": case "home": return 3;
            case "最近任务": case "任务": case "recents": return 187;
            case "回车": case "确定": case "enter": return 66;
            case "退格": case "删除": case "backspace": return 67;
            case "空格": case "space": return 62;
            case "菜单": case "menu": return 82;
            case "上": case "up": return 19;
            case "下": case "down": return 20;
            case "左": case "left": return 21;
            case "右": case "right": return 22;
            case "音量加": case "volume_up": return 24;
            case "音量减": case "volume_down": return 25;
            case "电源": case "power": return 26;
            case "截屏": case "screenshot": return 120;
            case "tab": return 61;
            case "esc": return 111;
            default:
                break;
        }
        try {
            return Integer.parseInt(k);
        } catch (NumberFormatException error) {
            return null;
        }
    }

    static final String KEY_HELP =
        "可用键名：返回 / 主页 / 最近任务 / 回车 / 退格 / 空格 / 菜单 / 上 / 下 / 左 / 右 / 音量加 / 音量减 / 电源（也可以直接写 keycode 数字）";

    /** 包成 sh 的单引号字符串。单引号本身要写成 '\'' 才能安全收尾再续上。 */
    private static String quote(String value) {
        if (value == null) return "''";
        return "'" + value.replace("'", "'\\''") + "'";
    }

    /**
     * 命令结果整理成人能看的样子。
     *
     * <p>Android 上大量命令会把成功信息写到 stderr，只看 stdout 会误判成失败，
     * 所以两边都带上，并且优先展示有内容的那一边。
     */
    static String describeResult(ShellProcess.Result result, String backendLabel) {
        StringBuilder builder = new StringBuilder();
        String out = result.stdout == null ? "" : result.stdout.trim();
        String err = result.stderr == null ? "" : result.stderr.trim();

        if (result.timedOut) {
            builder.append("命令超时被中止了（").append(backendLabel).append("）。");
            if (!out.isEmpty()) builder.append("\n超时前已输出：\n").append(clip(out));
            return builder.toString();
        }
        if (!out.isEmpty()) builder.append(clip(out));
        if (!err.isEmpty()) {
            if (builder.length() > 0) builder.append('\n');
            builder.append("（系统输出）").append(clip(err));
        }
        if (builder.length() == 0) {
            builder.append(result.code == 0 ? "命令已执行，没有输出。" : ("命令执行失败，退出码 " + result.code + "。"));
        }
        return builder.toString();
    }

    private static String clip(String text) {
        int limit = 6000;
        if (text.length() <= limit) return text;
        return text.substring(0, limit) + "\n…（内容过长已截断）";
    }
}
