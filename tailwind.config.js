// Tailwind 构建时配置：由 scripts/build-tailwind.mjs 调用，产物直接进 web/css/tailwind.css。
// 运行时不再加载引擎，所以这里的 content 必须覆盖一切会产出工具类名的地方，
// 漏一个目录就是那片界面丢样式。
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    // 首屏骨架、静态壳层与内联模板全部住在这里。
    './web/index.html',
    // 界面组件在 JS 里拼 DOM，工具类以字符串字面量形式写在源码里，
    // 扫描源码等价于扫描最终 DOM 的类名集合（没有由变量计算出的 Tailwind 类名）。
    './web/js/**/*.js',
    // 扩展包会把自己的 DOM 注入宿主页面，它们用的工具类与宿主同一套规则。
    './mods/**/*.js',
    './mods/**/*.html',
  ],
  // 只出现在条件表达式分支里、没有任何静态 class 属性引用的工具类。
  // 扫描器通常也能从字符串字面量提取到它们，列出是为了防止扫描规则变化后静默丢样式。
  safelist: [
    'rotate-90',
    'fill-current',
    'hover:bg-white/50',
    'bg-slate-400',
    'transition-[width]',
    'duration-150',
  ],
  theme: {},
  plugins: [],
};
