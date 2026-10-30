/* ============================================================================
 * 场景背景图（公共资源插件）
 *
 * 与 elaina-avatar 完全同一套路：**只提供资源与接口，不提供界面**，
 * 被「Galgame 界面」与「Live2D 视频通话」依赖。
 *
 * ── 为什么从 galgame 里分出来 ──────────────────────────────────────────────
 *
 * 这批图原先住在 `web/mods/galgame/img/bg/`（31 张 / 7.25 MB），
 * 但用它的**不只是 galgame**：视频通话也要拿它们当背景。
 * 让视频通话去 `host.require('galgame')` 是错的 —— 那意味着
 * "想要背景就得先启用剧情界面"，而且卸载 galgame 会把背景一起带走。
 *
 * 资源与消费者分开之后：
 *   · 想要背景 → 装/启用这一个资源包，两个界面都能用
 *   · 不想要剧情界面 → 关掉 galgame，背景照样在
 *
 * ── 对外接口（挂到 window.ElainaSceneBackgrounds）──────────────────────────
 *   list()              [{ file, label, url }] 全部背景（file 是文件名，不带扩展名）
 *   url(file)           文件名 → 背景图 URL（未知文件名返回空串）
 *   label(file)         文件名 → 中文标签（认不出就回文件名本身）
 *   pick(keyword)       按中文标签/文件名模糊挑一张（供 AI 的 [背景:雪夜] 用）
 *   has(file)           这个文件名存不存在
 * ========================================================================== */
(function () {
    'use strict';

    const MOD_ID = 'scene-backgrounds';

    /* 资源基址：★ 不写死目录名。
       声明的 id 与实际安装目录可能不一致（历史版本装出过带版本号的目录），
       写死 '/mods/scene-backgrounds/img/bg/' 会在那时全部 404。
       优先用宿主注入的 assetBase（来自清单归一化后的真实目录）。 */
    let BASE = '/mods/' + MOD_ID + '/img/bg/';

    /**
     * 场景库：文件名 → 中文标签。**与 img/bg/ 下的实际文件一一对应**。
     *
     * 顺序就是界面上的顺序（按场景类型粗排：娱乐 → 室内 → 室外 → 天气）。
     * 加图时在这里补一行；`check-scene-backgrounds` 会核对两边是否一一对应 ——
     * 漏一行不会报错，只是那张图在列表里选不到（静默失效），所以要检查盯着。
     */
    const BGS = [
        ['amusement_park', '游乐园'], ['amusement_plaza', '游乐园广场'], ['arcade', '街机厅'],
        ['bedroom', '卧室'], ['bedroom_cosy', '温馨卧室'], ['bedroom_morning', '清晨卧室'],
        ['cafe', '咖啡厅'], ['carousel', '旋转木马'], ['city_park', '城市公园'],
        ['clothing_shop', '服装店'], ['fastfood', '快餐店'], ['ferris_wheel', '摩天轮'],
        ['flashback', '回忆'], ['furniture_shop', '家具店'], ['kitchen', '厨房'],
        ['lake_trail_broken', '雪湖栈道·破'], ['lake_trail_snow', '雪湖栈道'], ['mall', '商场'],
        ['market', '集市'], ['restaurant', '餐厅'], ['rollercoaster', '过山车'],
        ['room_day', '房间·白天'], ['room_night', '房间·夜晚'], ['room_snow', '房间·雪天'],
        ['shooting_booth', '拍立得亭'], ['snowy_street', '雪之街'], ['street_dusk', '黄昏街道'],
        ['street_snow_night', '雪夜街道'], ['swan_lake', '天鹅湖'], ['swan_lake_pavilion', '天鹅湖亭'],
        ['window_winter', '冬日窗边'],
    ];

    const BY_FILE = new Map(BGS.map(([f, l]) => [f, l]));

    const url = (file) => (BY_FILE.has(file) ? BASE + file + '.jpg' : '');
    const label = (file) => BY_FILE.get(file) || String(file || '');
    const has = (file) => BY_FILE.has(file);

    /** 全部背景（顺序即界面顺序） */
    function list() {
        return BGS.map(([file, label2]) => ({ file, label: label2, url: url(file) }));
    }

    /**
     * 按关键词挑一张：先精确命中文件名，再命中中文标签，最后子串匹配。
     *
     * 为什么需要它：AI 的 `[背景:雪夜]` 给的是中文/模糊说法，
     * 而内部用的是文件名（street_snow_night）。映射放在资源侧，
     * 两个消费方（galgame / 视频通话）就不用各写一份匹配逻辑。
     */
    function pick(keyword) {
        const k = String(keyword || '').trim();
        if (!k) return null;
        if (BY_FILE.has(k)) return { file: k, label: BY_FILE.get(k), url: url(k) };
        // 中文标签精确匹配
        for (const [file, lab] of BGS) {
            if (lab === k) return { file, label: lab, url: url(file) };
        }
        // 子串（标签含关键词，或关键词含标签）
        for (const [file, lab] of BGS) {
            if (lab.includes(k) || k.includes(lab)) return { file, label: lab, url: url(file) };
        }
        // 文件名子串
        for (const [file, lab] of BGS) {
            if (file.includes(k)) return { file, label: lab, url: url(file) };
        }
        return null;
    }

    window.ElainaSceneBackgrounds = { list, url, label, has, pick, base: BASE };

    if (window.ElainaMods && typeof window.ElainaMods.register === 'function') {
        window.ElainaMods.register(MOD_ID, function (host) {
            // 用宿主给的真实安装位置覆盖约定路径（见上面 BASE 的说明）
            if (host && typeof host.assetBase === 'function') {
                BASE = host.assetBase() + 'img/bg/';
                window.ElainaSceneBackgrounds.base = BASE;
            }
            host.log('背景资源就绪（' + BGS.length + ' 张，基址 ' + BASE + '）');
            return { list, url, label, has, pick, base: () => BASE };
        });
    }
})();
