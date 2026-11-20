// 后台副屏 holder 的跨进程接口。
//
// 为什么需要 AIDL：虚拟屏属于**创建它的进程**，进程一退屏就没了。
// 所以建屏不能是一次性命令，必须有一个常驻进程持有它 —— Shizuku 里是
// UserService（shell uid 或 root uid），Root 里是 su 起出来的 app_process（uid 0）。
// 两者都用这份接口，应用侧只写一套调用。
//
// 只暴露**语义动作**（启动应用 / 点击 / 截图 / 读界面），不暴露任意 shell：
// 命令通道一旦开放，任何能拿到这个 Binder 的代码就等于拿到 root。
//
// ⚠️ 所有方法都必须显式写 id：AIDL 的规则是"要么全写、要么全不写"，
// 而 destroy 必须固定 16777114（Shizuku 服务端用它调销毁），所以其余方法一并编号。
package com.elainachat.mod;

interface IDisplayHolder {
    // Shizuku 服务端固定用 16777114 调 destroy：进程被它杀掉前要在这里释放副屏，
    // 否则虚拟屏会跟着进程一起消失、但系统侧状态可能残留。
    void destroy() = 16777114;

    /** 创建（或复用）副屏，返回 displayId；失败抛异常，消息可直接给用户看。 */
    int createDisplay(int width, int height, int dpi, String name) = 1;

    /** 当前副屏 id；没有时返回 -1。 */
    int displayId() = 2;

    /** 把应用启动到副屏。component 形如 pkg/.Activity；空串表示按包名解析。 */
    void launch(String pkg, String component) = 3;

    /** 副屏上的前台应用包名；读不到返回空串。 */
    String foreground() = 4;

    /** 点击副屏坐标（durationMs >= 400 视为长按）。 */
    void tap(int x, int y, int durationMs) = 5;

    /** 副屏滑动。 */
    void swipe(int x1, int y1, int x2, int y2, int durationMs) = 6;

    /** 向副屏发按键（keycode）。 */
    void key(int keyCode) = 7;

    /** 输入文本：ASCII 走 input text，非 ASCII 走剪贴板粘贴，失败抛异常。 */
    void inputText(String text) = 8;

    /** 读副屏控件树（已过滤到目标 display，文本形式）。 */
    String dumpUi() = 9;

    /** 截副屏当前帧，返回 PNG 字节。 */
    byte[] capture() = 10;
}
