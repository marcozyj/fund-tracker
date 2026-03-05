export const extractFundNamesWithLLM = async (ocrText: string) => {
  const isString = (value: unknown): value is string => typeof value === 'string';
  const apiKey = process.env.NEXT_PUBLIC_GLM_API_KEY;
  if (!apiKey || !ocrText) return [];

  try {
    const models = ['glm-4.5-flash', 'glm-4.7-flash'];
    const model = models[Math.floor(Math.random() * models.length)];

    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content:
              '你是一个基金 OCR 文本解析助手。' +
              '从下面的 OCR 文本中抽取其中出现的「基金名称列表」。' +
              '要求：1）基金名称一般为中文，中间不能有空字符串,可包含部分英文或括号' +
              '2）名称后面通常会跟着金额或持有金额（数字，可能带千分位逗号和小数）；' +
              '3）忽略无关信息，只返回你判断为基金名称的字符串；' +
              '4）去重后输出。输出格式：严格返回 JSON，如 {"fund_names": ["基金名称1","基金名称2"]}，不要输出任何多余说明'
          },
          {
            role: 'user',
            content: String(ocrText)
          }
        ],
        temperature: 0.2,
        max_tokens: 1024,
        thinking: { type: 'disabled' }
      })
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content?.match(/\{[\s\S]*?\}/)?.[0];
    if (!isString(content)) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }

    const names = parsed?.fund_names;
    if (!Array.isArray(names)) return [];
    return names.map((name) => (isString(name) ? name.trim().replaceAll(' ', '') : '')).filter(Boolean);
  } catch {
    return [];
  }
};
