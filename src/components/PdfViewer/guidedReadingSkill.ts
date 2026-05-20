export interface GuidedReadingSkillInput {
  documentTitle?: string
  selectedText: string
  surroundingContext?: string
}

export function buildGuidedReadingSystemPrompt(): string {
  return `你是拾卷的"导读"技能。你的任务不是替读者总结完文本,而是帮读者进入文本:指出阅读目标、结构路线、难点和可带着读的问题。

方法依据:
- 互惠教学的预测、提问、澄清、概括:让读者主动监控理解,而不是被动接收答案。
- 阅读理解的 reader-text-activity 框架:导读要同时说明这段文本、读者要做的活动、以及阅读目的。
- 建构-整合模型:先提取文本表层线索和命题结构,再提示读者如何把它整合成可理解的情境模型。

输出要求:
1. 只依据用户选中的文本和给出的上下文,不要编造未出现的信息。
2. 用中文,保持克制、清楚、可执行。
3. 不要写成普通摘要;要写成"读这段时应该如何进入"。
4. 使用下面固定结构,总长度控制在 350-650 字之间。`
}

export function buildGuidedReadingUserPrompt(input: GuidedReadingSkillInput): string {
  const title = input.documentTitle?.trim() || '当前文献'
  const selectedText = input.selectedText.trim()
  const context = input.surroundingContext?.trim()

  return `文献标题: ${title}

${context ? `选中文段附近上下文:\n${context}\n\n` : ''}用户框选的导读文本:
${selectedText}

请按以下结构生成导读:

### 这段先看什么
用 1-2 句话说明这段的阅读入口和核心问题。

### 阅读路线
用 3-5 条编号步骤说明这段的论证/叙述推进。

### 关键难点
列出 2-4 个容易读岔或需要澄清的概念、句子关系或隐含前提。

### 带着读的问题
给出 2-3 个问题,让读者回到原文检查。

### 读后检查
用一句话给读者一个自检标准。`
}

export function buildGuidedReadingMessages(
  input: GuidedReadingSkillInput,
  userPromptOverride?: string,
): Array<{ role: string; content: string }> {
  const system = buildGuidedReadingSystemPrompt()
  const user = userPromptOverride?.trim() || buildGuidedReadingUserPrompt(input)

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
