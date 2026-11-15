package com.elainachat.mod;

import android.os.Bundle;
import android.webkit.ValueCallback;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ByokSecretsPlugin.class);
        registerPlugin(ByokHttpPlugin.class);
        // 日志导出：拉系统「创建文档」选择器让用户自选保存位置（SAF，无需存储权限）。
        registerPlugin(ElainaExportPlugin.class);
        // 手机操作的原生设备层。注册后 Capacitor 会往页面注入
        // window.Capacitor.Plugins.ElainaDevice，前端再给它挂个 window.ElainaDevice 别名。
        registerPlugin(ElainaShellPlugin.class);
        // Edge TTS：必须在原生层建 WebSocket —— WebView 的 new WebSocket() 不能自定义
        // 请求头，而微软端点校验 User-Agent，缺了直接 403（实测：补齐头后立刻 101）。
        registerPlugin(EdgeTtsPlugin.class);
        // 本地服务（Go 单文件）：日志接口、中继与插件服务端半边都在它里面。
        // 开关默认开（app/build.gradle 的 buildLocalServer）；关掉时不注册插件，
        // 页面里没有 ElainaNode，一切走原生兜底实现。
        if (BuildConfig.LOCAL_SERVER) {
            registerPlugin(ElainaNodePlugin.class);
        }
        super.onCreate(savedInstanceState);
        bindSystemBack();
    }

    /**
     * 系统返回（硬件返回键 / 返回手势）：先问页面要不要吃掉这次返回，没人接手才退出应用。
     *
     * 为什么必须在这里接：Capacitor 核心不注册返回键回调，BACK 键落到 Activity 默认行为就是
     * finish()，页面里的 history/popstate 根本收不到 —— 表现为"设置开着按返回，整个应用退了"。
     *
     * 页面侧返回 true 表示已关掉一层（弹层 / 二级页 / 页面），返回 false 表示已经在主界面；
     * 后者先退 WebView 历史（兼容页面自己 pushState 的层），没有历史才交还系统退出。
     */
    private void bindSystemBack() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final Bridge bridge = getBridge();
                if (bridge == null || bridge.getWebView() == null) {
                    exitApp();
                    return;
                }
                bridge.getWebView().evaluateJavascript(
                    "(function(){try{var h=window.ElainaHost&&window.ElainaHost.systemBack;"
                        + "return h?(h()?'true':'false'):'false'}catch(e){return 'false'}})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if ("\"true\"".equals(value) || "true".equals(value)) return;
                            if (bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
                                bridge.getWebView().goBack();
                                return;
                            }
                            exitApp();
                        }
                    });
            }

            private void exitApp() {
                // 关掉自己再走默认路径，否则 onBackPressed 会再次进到这个回调里绕圈。
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }
}