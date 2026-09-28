/**
 * 客户端装载器 wrapper —— 真源。
 *
 * 构建时 scripts/build.mjs 会把 esbuild 的 IIFE 产物**插入**下面 factory 函数体内
 * 标有 bundle 占位符的那一行（占位符字样只在该行出现一次，这里不重复写出）。
 *
 * 为什么产物必须在 factory 内部：
 *   impl.mjs 顶层就 `import ... from 'react'`，esbuild 会把它提升成顶层的一次
 *   require；而 DSH 的 require 只是 factory 的**参数**。
 *   产物一旦落在 factory 之外，就会在脚本顶层执行到那次 require ——
 *   esbuild 的 __require 垫片会抛 "Dynamic require of \"react\" is not supported"，
 *   整个 /plugins 拼接 bundle 全灭（症状会报在别的插件上，极难归因）。
 *
 * ⚠️ 本注释**刻意不写出 `require("react")` 这个字面量**，也不写出占位符字样。
 *    两者都会被构建/发布的断言当成"真代码"扫到：早先注释里写了它们，
 *    于是断言在**注释**上命中、把健康的产物判成"产物落在了工厂外面"（实测踩过两次）。
 *    教训：凡是"字符串包含式"的断言，注释就是它的天敌 —— 要么让注释不含针，
 *    要么让判据只在真代码区域生效。这里两条都做了。
 *
 * 这条约束由三处断言守着：
 *   · 构建期：装配后断言占位符行消失、文件变大；
 *   · 构建期：断言 esbuild 的 IIFE（`var <全局名> = (`）出现在 `factory:` **之后** ——
 *     产物在工厂外时，这个位置关系必然颠倒；
 *   · 发布期：verify 做同样的位置断言。
 *
 * 平台冻结模块表只提供 react / react-dom / react/jsx-runtime / react-dom/client。
 */
window.__ModuleLoader__.load({
  id: '@yiyunet/dsh-learn-skills',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    // __DSH_CLIENT_BUNDLE__

    Object.assign(module.exports, __DshLearnSkills)
    return module.exports
  },
})
