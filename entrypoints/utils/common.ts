// 防抖限流函数，可传递参数
import {franc} from "franc-min";

// 防抖限流函数，可传递参数
export function throttle(fn: (...args: any[]) => void, interval: number) {
    let last = 0; // 维护上次执行的时间
    return function (this: any, ...args: any[]) {
        const now = Date.now();
        // 只有当前时间与上次执行时间差大于等于间隔时才执行
        if (now - last >= interval) {
            last = now;
            fn.apply(this, args);  // 使用 apply 来传递参数数组
        }
    };
}

// 输出标准的语言类型，franc 只返回最可信的结果，francAll 返回所有结果并包含确信度
export function detectlang(origin: string): string {
    const find = franc(origin, {minLength: 0});
    // 返回对应的标准语言代码
    switch (find) {
        case "cmn":
            return "zh-Hans";
        case "eng":
            return "en";
        case "jpn":
            return "ja";
        case "kor":
            return "ko";
        case "fra":
            return "fr";
        case "rus":
            return "ru";
        default:
            return find; // 返回其他语言的识别结果
    }
}

// 获取触摸点的中心位置
export function getCenterPoint(touches: TouchList, point: number): { x: number, y: number } | undefined {
    // 检查触摸点数量是否等于指定的数量
    if (touches.length !== point) return;

    let centerX = 0;
    let centerY = 0;
    // 累加所有触摸点的坐标
    for (let i = 0; i < touches.length; i++) {
        centerX += touches[i].clientX;
        centerY += touches[i].clientY;
    }
    // 计算中心点坐标
    centerX /= touches.length;
    centerY /= touches.length;

    return {x: centerX, y: centerY};
}

// 按 selector 查找匹配的元素，返回匹配的元素或 false
export function findMatchingElement(element: Element, selector: string): Element | false {
    // 检查当前元素是否匹配传入的选择器
    if (element.matches(selector)) return element;

    // 遍历父元素，直到找到匹配的元素或没有父元素
    let parent = element.parentElement;
    while (parent) {
        if (parent.matches(selector)) return parent;
        parent = parent.parentElement;
    }

    return false; // 未找到匹配元素
}

// 基于 Unicode 的跨语言单词计数：
// - 对拉丁等以空格分词的语言：按单词边界统计（字母/数字串，允许带省略号/撇号连接）
// - 对中日韩文字：按单个字符计数（近似处理，以避免整段中文被当作一个“单词”）
export function countWords(text: string): number {
  if (!text) return 0;
  // CJK 单字符匹配（汉字、平假名、片假名、谚文）
  const cjkRegex = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const cjkMatches = text.match(cjkRegex) || [];

  // 将 CJK 字符替换为空格，避免与后续“单词”重复计数
  const nonCjk = text.replace(cjkRegex, ' ');
  // 通用“单词”匹配：连续的字母(含变音)、可选内部撇号连接；或连续数字
  const generalWordRegex = /\p{L}+(?:['’]\p{L}+)?|\p{N}+/gu;
  const generalMatches = nonCjk.match(generalWordRegex) || [];

  return cjkMatches.length + generalMatches.length;
}