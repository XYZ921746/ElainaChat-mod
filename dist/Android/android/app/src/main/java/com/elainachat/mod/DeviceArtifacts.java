package com.elainachat.mod;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;
import android.util.Xml;

import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 处理命令族后端产出的两样东西：{@code uiautomator dump} 的 XML 和 {@code screencap} 的 PNG。
 *
 * <p>都不直接丢给模型：XML 要压成扁平文本（省 token、也不容易被层级看错），
 * 截图要缩到模型能接受的大小（并且**必须把缩放比报出来**，否则模型算出的坐标会整体偏移）。
 */
final class DeviceArtifacts {

    private DeviceArtifacts() {}

    private static final int MAX_CHARS = 24000;
    private static final int MAX_NODES = 400;

    /** 截图缩放后长边的目标像素。再大对判断控件位置没有帮助，只是烧 token。 */
    private static final int SCREENSHOT_MAX_SIDE = 1120;

    private static final Pattern BOUNDS = Pattern.compile("\\[(\\d+),(\\d+)]\\[(\\d+),(\\d+)]");

    // ==================== 控件树 ====================

    /**
     * 把 {@code uiautomator dump} 出来的 XML 压成「一行一个元素」的扁平文本。
     *
     * <p>为什么不用嵌套 JSON：层级信息对模型判断"点哪里"帮助有限，但会让字符数翻几倍。
     * 扁平文本 + 元素中心坐标，模型更容易直接用。
     */
    static String flattenUiXml(File file) {
        if (file == null || !file.isFile()) {
            return "没有拿到界面结构文件（uiautomator dump 可能失败了）。";
        }
        StringBuilder builder = new StringBuilder();
        int count = 0;
        boolean truncated = false;

        try (FileInputStream input = new FileInputStream(file)) {
            XmlPullParser parser = Xml.newPullParser();
            parser.setInput(input, "utf-8");

            int event = parser.getEventType();
            while (event != XmlPullParser.END_DOCUMENT) {
                if (event == XmlPullParser.START_TAG && "node".equals(parser.getName())) {
                    if (count >= MAX_NODES) {
                        truncated = true;
                        break;
                    }
                    String line = describeNode(parser, count);
                    if (line != null) {
                        if (builder.length() + line.length() > MAX_CHARS) {
                            truncated = true;
                            break;
                        }
                        builder.append(line).append('\n');
                        count++;
                    }
                }
                event = parser.next();
            }
        } catch (Exception error) {
            if (builder.length() == 0) {
                return "解析界面结构失败：" + ShellProcess.describe(error);
            }
            truncated = true;
        }

        if (count == 0) return "界面结构里没有任何可读元素。";
        if (truncated) builder.append("…（元素过多，已截断。可先滑动或缩小范围再读）\n");
        builder.append("共 ").append(count).append(" 个元素。");
        return builder.toString();
    }

    private static String describeNode(XmlPullParser parser, int index) {
        String text = attr(parser, "text");
        String desc = attr(parser, "content-desc");
        String id = attr(parser, "resource-id");
        String className = attr(parser, "class");
        boolean clickable = "true".equals(attr(parser, "clickable"));
        boolean scrollable = "true".equals(attr(parser, "scrollable"));
        boolean checkable = "true".equals(attr(parser, "checkable"));
        boolean checked = "true".equals(attr(parser, "checked"));
        boolean enabled = !"false".equals(attr(parser, "enabled"));
        String bounds = attr(parser, "bounds");

        boolean hasText = !text.isEmpty() || !desc.isEmpty();
        if (!hasText && id.isEmpty() && !clickable && !scrollable && !checkable) return null;

        StringBuilder line = new StringBuilder();
        line.append('#').append(index).append(' ');
        if (!text.isEmpty()) line.append('“').append(clip(text, 80)).append('”');
        else if (!desc.isEmpty()) line.append("[描述]“").append(clip(desc, 80)).append('”');
        else line.append(shortName(className));

        if (!id.isEmpty()) {
            int slash = id.lastIndexOf('/');
            line.append(" id=").append(slash >= 0 ? id.substring(slash + 1) : id);
        }
        if (clickable) line.append(" 可点");
        if (scrollable) line.append(" 可滑");
        if (checkable) line.append(checked ? " 已选" : " 未选");
        if (!enabled) line.append(" 禁用");

        Matcher matcher = BOUNDS.matcher(bounds);
        if (matcher.find()) {
            try {
                Rect rect = new Rect(
                    Integer.parseInt(matcher.group(1)),
                    Integer.parseInt(matcher.group(2)),
                    Integer.parseInt(matcher.group(3)),
                    Integer.parseInt(matcher.group(4))
                );
                line.append(" [").append(rect.centerX()).append(',').append(rect.centerY()).append(']');
            } catch (NumberFormatException ignored) {
                // 坐标解析不出来就不带坐标，至少文字还有用
            }
        }
        return line.toString();
    }

    private static String attr(XmlPullParser parser, String name) {
        String value = parser.getAttributeValue(null, name);
        return value == null ? "" : value.replace('\n', ' ').trim();
    }

    private static String clip(String value, int limit) {
        return value.length() <= limit ? value : value.substring(0, limit) + "…";
    }

    private static String shortName(String className) {
        if (className == null || className.isEmpty()) return "View";
        int dot = className.lastIndexOf('.');
        return dot >= 0 && dot < className.length() - 1 ? className.substring(dot + 1) : className;
    }

    // ==================== 截图 ====================

    /**
     * 读截图并缩小，返回 base64 + 尺寸 + **缩放比**。
     *
     * <p>缩放比必须带出去：模型看到的是缩小后的图，但它给的坐标要落到真实屏幕上，
     * 不告诉它比例，点击位置就会整体偏。
     */
    static JSONObject readScreenshot(File file) throws Exception {
        if (file == null || !file.isFile()) {
            throw new IllegalStateException("没有拿到截图文件（screencap 可能被拒绝了）");
        }

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IllegalStateException("截图文件不是有效的图片");
        }

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        options.inPreferredConfig = Bitmap.Config.RGB_565;

        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (bitmap == null) throw new IllegalStateException("截图解码失败");

        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, 72, buffer);
        byte[] jpeg = buffer.toByteArray();

        double scaleX = bounds.outWidth / (double) bitmap.getWidth();
        double scaleY = bounds.outHeight / (double) bitmap.getHeight();

        JSONObject result = new JSONObject();
        result.put("imageBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP));
        result.put("imageMime", "image/jpeg");
        result.put("imageBytes", jpeg.length);
        result.put("screenWidth", bounds.outWidth);
        result.put("screenHeight", bounds.outHeight);
        result.put("imageWidth", bitmap.getWidth());
        result.put("imageHeight", bitmap.getHeight());
        result.put("scaleX", round(scaleX));
        result.put("scaleY", round(scaleY));
        bitmap.recycle();
        return result;
    }

    private static int sampleSize(int width, int height) {
        int longest = Math.max(width, height);
        int sample = 1;
        while (longest / sample > SCREENSHOT_MAX_SIDE * 2) sample *= 2;
        return sample;
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    /** 截图附带的一句说明，直接回灌给模型。 */
    static String describeScreenshot(JSONObject meta) {
        return "已截取当前屏幕。\n"
            + "屏幕真实尺寸：" + meta.optInt("screenWidth") + " × " + meta.optInt("screenHeight") + " 像素。\n"
            + "给你的图片已缩小到 " + meta.optInt("imageWidth") + " × " + meta.optInt("imageHeight") + "。\n"
            + "**图片上的坐标要乘 " + meta.optDouble("scaleX", 1) + "（横向）和 "
            + meta.optDouble("scaleY", 1) + "（纵向）才是屏幕真实坐标**，点击时要用真实坐标。";
    }
}
