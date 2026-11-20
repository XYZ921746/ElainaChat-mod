# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ============================================================
# ★ 2026-10：R8 瘦身（release 的 minifyEnabled 打开）之后必须保住的几类东西
# ============================================================
#
# Capacitor 的插件是**按类名反射装配**的：插件类名被混淆成 a.b.c，
#   Capacitor 就找不到它 —— 表现是"装得上、点不动"，而且日志里只有一句
#   "Plugin not found"。自定义插件（ElainaByokHttp / ElainaSecrets /
#   ElainaDevice …）不属于 Capacitor 自带 consumer 规则的覆盖范围，必须自己保。

# 1) 本项目自己的类：体积占比极小（大头是 AndroidX/Capacitor 的库），全留着最稳 ——
#    MainActivity、各原生插件、无障碍服务都在这包下。
-keep class com.elainachat.mod.** { *; }

# 1b) Shizuku / Sui 的 API 类：ShizukuProvider 与 UserService 都按类名跨进程装配，
#     混淆后会表现为"授权了但绑不上 holder"。
-keep class rikka.shizuku.** { *; }
-keep class rikka.sui.** { *; }
-keep class moe.shizuku.** { *; }

# 2) 所有 Capacitor 插件基类的子类 + @CapacitorPlugin 注解 + @PluginMethod 方法
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod <methods>;
}

# 3) WebView 的 JS 接口（若以后用到 @JavascriptInterface）
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 4) ★★ 2026-10 修：Capacitor **自身**的注解/权限/ActivityResult 机制必须整包保留。
#
#    规则 1~3 只保住了"我们自己的插件类"，但 R8 仍然把 Capacitor 基类里
#    那套"读 @CapacitorPlugin 注解 → 申请权限"的代码优化坏了。
#
#    实测（release 包，点 设置 → 能力 → 手机操作 → 读取信息 → 申请权限 必崩）：
#      FATAL EXCEPTION: CapacitorPlugins
#      Caused by: java.lang.NullPointerException
#          at com.getcapacitor.Plugin.requestPermissionForAliases
#          at com.getcapacitor.Plugin.requestPermissionForAlias
#          at com.elainachat.mod.ElainaShellPlugin.requestReadPermission
#    反汇编 release 的 classes.dex 确认了 R8 干了什么：
#      · requestPermissionForAliases 的方法体被替换成 `const/4 v0,#0; throw v0`（抛 null）
#      · requestAllPermissions 被清空成 `handle.getClass(); return-void`
#    两者都依赖 `PluginHandle` 里保存的注解实例与 `@Permission(strings=…)` 的值。
#    R8 把那个注解字段的赋值当成死代码删了 → `getPluginAnnotation()` 恒为 null
#    → 解引用即 NPE。这是 Capacitor + R8 的经典坑：**只 keep 子类不够**。
#
#    代价：Capacitor 库那一部分不再被裁剪，dex 会大一点（实测约 +0.x MB）——
#    与"点一下就闪退"相比这点体积完全可以接受。
#    ⚠️ 不要删这两行；删了 release 包的权限申请会立刻退回闪退。
-keepattributes *Annotation*
-keep class com.getcapacitor.** { *; }
