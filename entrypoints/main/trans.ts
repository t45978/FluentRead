import { checkConfig, searchClassName, skipNode } from "../utils/check";
import { cache } from "../utils/cache";
import { options, servicesType } from "../utils/option";
import { insertFailedTip, insertLoadingSpinner } from "../utils/icon";
import { styles } from "@/entrypoints/utils/constant";
import { beautyHTML, grabNode, grabAllNode, LLMStandardHTML, smashTruncationStyle } from "@/entrypoints/main/dom";
import { detectlang, throttle, countWords } from "@/entrypoints/utils/common";
import { getMainDomain, replaceCompatFn } from "@/entrypoints/main/compat";
import { config } from "@/entrypoints/utils/config";
import { translateText, cancelAllTranslations } from '@/entrypoints/utils/translateApi';

let hoverTimer: any; // 鼠标悬停计时器
let htmlSet = new Set(); // 防抖
export let originalContents = new Map(); // 保存原始内容
let isAutoTranslating = false; // 控制是否继续翻译新内容
let observer: IntersectionObserver | null = null; // 保存观察器实例
let mutationObserver: MutationObserver | null = null; // 保存 DOM 变化观察器实例

// 使用自定义属性标记已翻译的节点
const TRANSLATED_ATTR = 'data-fr-translated';
const TRANSLATED_ID_ATTR = 'data-fr-node-id'; // 添加节点ID属性

let nodeIdCounter = 0; // 节点ID计数器

// 新增：会话级原文去重集合（仅存于页面会话内）
const sessionSourceDedupSet = new Set<string>();

// 规范化用于会话去重的键：
// - 使用节点的纯文本（忽略 HTML 标签差异）
// - 收敛连续空白为单个空格
// - 去除首尾空白（含全角空格、NBSP）
function extractNodeTextForDedup(node: any): string {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? '';
    }
    if (node instanceof HTMLElement) {
        return node.innerText ?? '';
    }
    return node.textContent ?? '';
}

function getSessionDedupKeyFromNode(node: any): string {
    const text = extractNodeTextForDedup(node);
    return normalizeWhitespace(text);
}

function hasOwnMeaningfulText(node: Element): boolean {
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent && child.textContent.trim()) {
            return true;
        }
    }
    return false;
}

function shouldSkipContainerTranslation(node: Element): boolean {
    if (!node) return false;
    if (!hasOwnMeaningfulText(node)) {
        const elementChildren = Array.from(node.children).filter(child => {
            return !(child instanceof HTMLElement && child.classList.contains('fluent-read-loading'));
        });
        if (elementChildren.length > 0) {
            return true;
        }
    }
    return false;
}

function normalizeWhitespace(text: string): string {
    return text.replace(/[\s\u3000\u00A0]+/g, ' ').trim();
}

const identifierTokenReg = /^[A-Za-z0-9._-]+$/;

function shouldSkipAsIdentifier(text: string): boolean {
    const normalized = normalizeWhitespace(text);
    if (!normalized || normalized.length > 80) return false;

    const colonIndex = normalized.indexOf(':');
    if (colonIndex !== -1) {
        const left = normalized.slice(0, colonIndex).trim();
        const right = normalized.slice(colonIndex + 1).trim();
        if (left && right && !left.includes(' ') && !right.includes(' ') && identifierTokenReg.test(left) && identifierTokenReg.test(right)) {
            return true;
        }
    }

    if (normalized.includes('/')) {
        const parts = normalized.split('/').map(part => part.trim());
        if (parts.length === 2 && parts.every(part => part && !part.includes(' ') && identifierTokenReg.test(part))) {
            return true;
        }
    }

    if (!normalized.includes(' ') && /[-_]/.test(normalized)) {
        return identifierTokenReg.test(normalized);
    }

    return false;
}

// 恢复原文内容
export function restoreOriginalContent() {
    // 取消所有等待中的翻译任务
    cancelAllTranslations();
    
    // 1. 遍历所有已翻译的节点
    document.querySelectorAll(`[${TRANSLATED_ATTR}="true"]`).forEach(node => {
        const nodeId = node.getAttribute(TRANSLATED_ID_ATTR);
        if (nodeId && originalContents.has(nodeId)) {
            const originalContent = originalContents.get(nodeId);
            node.innerHTML = originalContent;
            node.removeAttribute(TRANSLATED_ATTR);
            node.removeAttribute(TRANSLATED_ID_ATTR);
            
            // 移除可能添加的翻译相关类
            (node as HTMLElement).classList.remove('fluent-read-bilingual');
        }
    });
    
    // 2. 移除所有翻译内容元素
    document.querySelectorAll('.fluent-read-bilingual-content').forEach(element => {
        element.remove();
    });
    
    // 3. 移除所有翻译过程中添加的加载动画和错误提示
    document.querySelectorAll('.fluent-read-loading, .fluent-read-retry-wrapper').forEach(element => {
        element.remove();
    });
    
    // 4. 清空存储的原始内容
    originalContents.clear();
    
    // 5. 停止所有观察器
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    
    // 6. 重置所有翻译相关的状态
    isAutoTranslating = false;
    htmlSet.clear(); // 清空防抖集合
    nodeIdCounter = 0; // 重置节点ID计数器

    // 6.5 清空会话去重集合
    sessionSourceDedupSet.clear();
    
    // 7. 消除可能存在的全局样式污染
    const tempStyleElements = document.querySelectorAll('style[data-fr-temp-style]');
    tempStyleElements.forEach(el => el.remove());
}

// 自动翻译整个页面的功能
export function autoTranslateEnglishPage() {
    // 如果已经在翻译中，则返回
    if (isAutoTranslating) return;
    
    // 获取当前页面的语言（暂时注释，存在识别问题）
    // const text = document.documentElement.innerText || '';
    // const cleanText = text.replace(/[\s\u3000]+/g, ' ').trim().slice(0, 500);
    // const language = detectlang(cleanText);
    // console.log('当前页面语言：', language);
    // const to = config.to;
    // if (to.includes(language)) {
    //     console.log('目标语言与当前页面语言相同，不进行翻译');
    //     return;
    // }
    // console.log('当前页面非目标语言，开始翻译');

    // 获取所有需要翻译的节点
    const nodes = grabAllNode(document.body);
    if (!nodes.length) return;

    isAutoTranslating = true;

    // 创建观察器
    observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && isAutoTranslating) {
                const node = entry.target as Element;

                // 去重
                if (node.hasAttribute(TRANSLATED_ATTR)) return;
                
                // 为节点分配唯一ID
                const nodeId = `fr-node-${nodeIdCounter++}`;
                node.setAttribute(TRANSLATED_ID_ATTR, nodeId);
                
                // 保存原始内容
                originalContents.set(nodeId, node.innerHTML);
                
                // 标记为已翻译
                node.setAttribute(TRANSLATED_ATTR, 'true');

                if (config.display === styles.bilingualTranslation) {
                    handleBilingualTranslation(node, false);
                } else {
                    handleSingleTranslation(node, false);
                }

                // 停止观察该节点
                observer.unobserve(node);
            }
        });
    }, {
        root: null,
        rootMargin: '50px',
        threshold: 0.1 // 只要出现10%就开始翻译
    });

    // 开始观察所有节点
    nodes.forEach(node => {
        observer?.observe(node);
    });

    // 创建 MutationObserver 监听 DOM 变化
    mutationObserver = new MutationObserver((mutations) => {
        if (!isAutoTranslating) return;
        
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) { // 元素节点
                    // 只处理未翻译的新节点
                    const newNodes = grabAllNode(node as Element).filter(
                        n => !n.hasAttribute(TRANSLATED_ATTR)
                    );
                    newNodes.forEach(n => observer?.observe(n));
                }
            });
        });
    });

    // 监听整个 body 的变化
    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// 处理鼠标悬停翻译的主函数
export function handleTranslation(mouseX: number, mouseY: number, delayTime: number = 0) {
    // 检查配置
    if (!checkConfig()) return;

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {

        let node = grabNode(document.elementFromPoint(mouseX, mouseY));

        // 判断是否跳过节点
        if (skipNode(node)) return;

        // 防抖
        let nodeOuterHTML = node.outerHTML;
        if (htmlSet.has(nodeOuterHTML)) return;
        htmlSet.add(nodeOuterHTML);

        // 根据翻译模式进行翻译
        if (config.display === styles.bilingualTranslation) {
            handleBilingualTranslation(node, delayTime > 0);  // 根据 delayTime 可判断是否为滑动翻译
        } else {
            handleSingleTranslation(node, delayTime > 0);
        }
    }, delayTime);
}

// 双语翻译
export function handleBilingualTranslation(node: any, slide: boolean) {
    let nodeOuterHTML = node.outerHTML;
    // 如果已经翻译过，250ms 后删除翻译结果
    let bilingualNode = searchClassName(node, 'fluent-read-bilingual');
    if (bilingualNode) {
        if (slide) {
            htmlSet.delete(nodeOuterHTML);
            return;
        }
        let spinner = insertLoadingSpinner(bilingualNode as HTMLElement, true);
        setTimeout(() => {
            spinner.remove();
            const content = searchClassName(bilingualNode as HTMLElement, 'fluent-read-bilingual-content');
            if (content && content instanceof HTMLElement) content.remove();
            (bilingualNode as HTMLElement).classList.remove('fluent-read-bilingual');
            htmlSet.delete(nodeOuterHTML);
        }, 250);
        return;
    }

    // 会话内原文去重（在任何缓存或请求之前判断，确保重复文本完全跳过）
    if (config.sessionDedupEnabled) {
        const key = getSessionDedupKeyFromNode(node);
        if (sessionSourceDedupSet.has(key)) {
            htmlSet.delete(nodeOuterHTML);
            return;
        }
        if (key) sessionSourceDedupSet.add(key);
    }

    const plainText = extractNodeTextForDedup(node);
    const normalizedPlainText = normalizeWhitespace(plainText);

    if (!normalizedPlainText) {
        htmlSet.delete(nodeOuterHTML);
        return;
    }

    if (shouldSkipAsIdentifier(normalizedPlainText)) {
        htmlSet.delete(nodeOuterHTML);
        return;
    }

    if (node instanceof Element && shouldSkipContainerTranslation(node)) {
        htmlSet.delete(nodeOuterHTML);
        return;
    }

    // 检查是否有缓存（即便有缓存也不应翻译重复文本，上方已提前拦截）
    const cacheKey = normalizedPlainText;
    let cached = cache.localGet(cacheKey);
    if (cached) {
        let spinner = insertLoadingSpinner(node, true);
        setTimeout(() => {
            spinner.remove();
            htmlSet.delete(nodeOuterHTML);
            bilingualAppendChild(node, cached);
        }, 250);
        return;
    }

    // 翻译
    bilingualTranslate(node, nodeOuterHTML);
}

// 单语翻译
export function handleSingleTranslation(node: any, slide: boolean) {
    let nodeOuterHTML = node.outerHTML;

    // 会话内原文去重（在任何缓存或请求之前判断与记录）
    if (config.sessionDedupEnabled) {
        const key = getSessionDedupKeyFromNode(node);
        if (sessionSourceDedupSet.has(key)) {
            try { htmlSet.delete(nodeOuterHTML); } catch {}
            return;
        }
        if (key) sessionSourceDedupSet.add(key);
    }

    const plainText = extractNodeTextForDedup(node);
    const normalizedPlainText = normalizeWhitespace(plainText);

    if (!normalizedPlainText) {
        try { htmlSet.delete(nodeOuterHTML); } catch {}
        return;
    }

    if (shouldSkipAsIdentifier(normalizedPlainText)) {
        try { htmlSet.delete(nodeOuterHTML); } catch {}
        return;
    }

    let outerHTMLCache = cache.localGet(node.outerHTML);

    if (outerHTMLCache) {
        // handleTranslation 已处理防抖故删除判断原bug 在保存完成后 刷新页面 可以取得缓存 直接return并没有翻译
        let spinner = insertLoadingSpinner(node, true);
        setTimeout(() => {
            spinner.remove();
            htmlSet.delete(nodeOuterHTML);

            // 兼容部分网站独特 DOM 结构
            let fn = replaceCompatFn[getMainDomain(document.location.hostname)];
            if (fn) fn(node, outerHTMLCache);
            else node.outerHTML = outerHTMLCache;

        }, 250);
        return;
    }

    singleTranslate(node);
}

function bilingualTranslate(node: any, nodeOuterHTML: any) {
    const textForDetect = node.textContent.replace(/[\s\u3000]/g, '');
    if (config.filterSkipSameAsTargetLanguage && detectlang(textForDetect) === config.to) return;
    if (config.filterSkipSimplifiedChinese && detectlang(textForDetect) === 'zh-Hans') return;
    if ((config.minTextLengthToTranslate || 0) > 0 && countWords(node.textContent) < (config.minTextLengthToTranslate || 0)) return;

    let origin = node.textContent;

    // 注意：此处不再创建并立即显示加载动画；由下面发送请求前创建
    let spinner = insertLoadingSpinner(node);
    
    // 使用队列管理的翻译API
    translateText(origin, document.title)
        .then((text: string) => {
            spinner.remove();
            htmlSet.delete(nodeOuterHTML);

            const normalizedOrigin = normalizeWhitespace(origin);
            const normalizedText = normalizeWhitespace(text);
            if (!normalizedText || normalizedText === normalizedOrigin) {
                return;
            }

            bilingualAppendChild(node, text);
        })
        .catch((error: Error) => {
            spinner.remove();
            insertFailedTip(node, error.toString() || "翻译失败", spinner);
        });
}


export function singleTranslate(node: any) {
    const textForDetect = node.textContent.replace(/[\s\u3000]/g, '');
    if (config.filterSkipSameAsTargetLanguage && detectlang(textForDetect) === config.to) return;
    if (config.filterSkipSimplifiedChinese && detectlang(textForDetect) === 'zh-Hans') return;
    if ((config.minTextLengthToTranslate || 0) > 0 && countWords(node.textContent) < (config.minTextLengthToTranslate || 0)) return;

    // 新增：会话内原文去重（按纯文本首尾去空格后判断）
    if (config.sessionDedupEnabled) {
        const key = getSessionDedupKeyFromNode(node);
        if (sessionSourceDedupSet.has(key)) {
            // 已出现过，跳过翻译与请求
            // single 模式也需要清理 htmlSet，避免持续防抖
            try { htmlSet.delete(node.outerHTML); } catch {}
            return;
        }
        if (key) sessionSourceDedupSet.add(key);
    }

    const plainText = extractNodeTextForDedup(node);
    const normalizedPlainText = normalizeWhitespace(plainText);
    if (!normalizedPlainText) {
        try { htmlSet.delete(node.outerHTML); } catch {}
        return;
    }
    if (shouldSkipAsIdentifier(normalizedPlainText)) {
        try { htmlSet.delete(node.outerHTML); } catch {}
        return;
    }

    let origin = servicesType.isMachine(config.service) ? node.innerHTML : LLMStandardHTML(node);
    let spinner = insertLoadingSpinner(node);
    
    // 使用队列管理的翻译API
    translateText(origin, document.title)
        .then((text: string) => {
            spinner.remove();
            
            text = beautyHTML(text);
            
            if (!text || origin === text) return;
            
            let oldOuterHtml = node.outerHTML;
            node.innerHTML = text;
            let newOuterHtml = node.outerHTML;
            
            // 缓存翻译结果
            cache.localSetDual(oldOuterHtml, newOuterHtml);
            cache.set(htmlSet, newOuterHtml, 250);
            htmlSet.delete(oldOuterHtml);
        })
        .catch((error: Error) => {
            spinner.remove();
            insertFailedTip(node, error.toString() || "翻译失败", spinner);
        });
}

export const handleBtnTranslation = throttle((node: any) => {
    let origin = node.innerText;
    let rs = cache.localGet(origin);
    if (rs) {
        node.innerText = rs;
        return;
    }

    config.count++ && storage.setItem('local:config', JSON.stringify(config));

    browser.runtime.sendMessage({ context: document.title, origin: origin })
        .then((text: string) => {
            cache.localSetDual(origin, text);
            node.innerText = text;
        }).catch((error: any) => console.error('调用失败:', error))
}, 250)


function bilingualAppendChild(node: any, text: string) {
    node.classList.add("fluent-read-bilingual");
    let newNode = document.createElement("span");
    newNode.classList.add("fluent-read-bilingual-content");
    // find the style
    const style = options.styles.find(s => s.value === config.style && !s.disabled);
    if (style?.class) {
        newNode.classList.add(style.class);
    }
    newNode.append(text);
    smashTruncationStyle(node);
    node.appendChild(newNode);
}