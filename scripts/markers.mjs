/**
 * markers.mjs —— 构建标记表与查找逻辑（**零依赖**，可被测试直接引用）。
 *
 * 为什么单独成模块：`build.mjs` 顶层 import 了 esbuild，而标记检查本身
 * 不需要 esbuild。把它留在一起，会让"标记契约测试"在没装构建依赖的机器上
 * 直接爆掉 —— 一条只在装了依赖时才跑得起来的契约测试，等于没有契约测试。
 *
 * @module dsh-learn-skills/markers
 */

/** 打包产物的全局名（wrapper 按这个名字取用）。 */
export const CLIENT_GLOBAL = '__DshLearnSkills'

/** 客户端只允许这些外部模块（平台冻结模块表）。 */
export const CLIENT_EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']

/** 四个入口的固定名称与顺序（界面契约：顺序固定、名称不变）。 */
export const ENTRY_LABELS = ['初始预设', '收集提炼', '关联升级', '沉淀复用']

/** 提交前必须断言的标记（每条都对应一个真实失败模式）。 */
export const REQUIRED_MARKERS = [
  { label: 'esbuild 全局名', needle: CLIENT_GLOBAL },
  { label: '装载器 id', needle: '@yiyunet/dsh-learn-skills' },
  { label: '槽位契约', needle: 'conversation.input.left' },
  { label: '菜单标题', needle: 'AI学习' },
  { label: 'RPC 端点名', needle: 'dsh-learn-skills' },
  ...ENTRY_LABELS.map((label, index) => ({ label: `入口${'一二三四'[index]}`, needle: label })),
]

/**
 * 在产物里找一个标记：**字面量与 `\uXXXX` 转义形态都算命中**。
 *
 * 为什么需要两形态：esbuild 会把非 ASCII 写成转义序列，于是"产物里没有这个中文串"
 * 很可能是假阴性 —— 串在，只是被转义了。早先本插件的构建就因此**误报缺标记**。
 * @param {string} haystack 产物文本
 * @param {string} needle 要找的串
 * @returns {'literal' | 'escaped' | undefined} 命中形态；未找到返回 undefined
 */
export function findMarker(haystack, needle) {
  if (haystack.includes(needle)) return 'literal'
  const escaped = [...needle].map(char => char.codePointAt(0) > 127
    ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`
    : char).join('')
  if (haystack.includes(escaped)) return 'escaped'
  // 大小写混合的转义（不同工具可能输出大写十六进制）
  const upper = [...needle].map(char => char.codePointAt(0) > 127
    ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`
    : char).join('')
  if (upper !== escaped && haystack.includes(upper)) return 'escaped'
  return undefined
}
