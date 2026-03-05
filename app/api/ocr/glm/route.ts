import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const DEFAULT_MODELS = ['glm-4v', 'glm-4v-flash', 'glm-4.1v', 'glm-4.7v'];

const getApiKey = () => process.env.GLM_API_KEY || process.env.NEXT_PUBLIC_GLM_API_KEY || '';

const extractJson = (value: string) => {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

export async function POST(req: Request) {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'GLM_OCR_KEY_MISSING' }, { status: 500 });
    }
    const payload = await req.json();
    const image = String(payload?.image || '');
    if (!image) {
      return NextResponse.json({ error: 'IMAGE_REQUIRED' }, { status: 400 });
    }

    const envModel = process.env.GLM_OCR_MODEL || '';
    const models = [envModel, ...DEFAULT_MODELS].map((m) => m.trim()).filter(Boolean);

    const prompt =
      '你是基金持仓截图识别助手，请严格按列解析并逐字抄写数字。' +
      '截图表头通常为：' +
      '1）名称；2）金额/昨日收益；3）持有收益/率。' +
      '请按以下规则抽取每只基金：' +
      'A. 从“金额/昨日收益”列中只取“持有金额”（通常是该列第一组数字，带千分位和两位小数），忽略“昨日收益”。' +
      'B. 从“持有收益/率”列中只取“持有收益金额”（通常是该列第一组数字），忽略“收益率(%)”。' +
      'C. 数字必须完整抄写，包含千分位逗号和小数位，禁止省略或截断。' +
      'D. 忽略“市场解读/今日收益更新/产品月报/金选指数基金/更多产品”等非持仓行。' +
      '输出严格 JSON：{"funds":[{"name":"基金名称","amount_text":"5,779.12","profit_text":"303.12","amount":5779.12,"profit":303.12}]}，' +
      '其中 amount_text/profit_text 为原样字符串，amount/profit 为对应数值。不要输出任何多余说明。';

    const buildBody = (model: string, variant: 'object' | 'string') => ({
      model,
      messages: [
        {
          role: 'user',
          content:
            variant === 'object'
              ? [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                ]
              : [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: `data:image/jpeg;base64,${image}` }
                ]
        }
      ],
      temperature: 0,
      max_tokens: 2048
    });

    let data: any = null;
    let lastError: string | null = null;
    const variants: Array<'object' | 'string'> = ['object', 'string'];

    for (const model of models) {
      for (const variant of variants) {
        const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(buildBody(model, variant))
        });

        data = await resp.json();
        if (resp.ok && !data?.error) {
          lastError = null;
          break;
        }
        lastError = data?.error?.message || data?.msg || data?.error || 'GLM_OCR_FAIL';
      }
      if (!lastError) break;
    }

    if (lastError) {
      return NextResponse.json({ error: lastError }, { status: 500 });
    }

    const content = String(data?.choices?.[0]?.message?.content || '');
    const parsed = extractJson(content);
    const funds =
      parsed?.funds ||
      parsed?.holdings ||
      parsed?.items ||
      [];

    return NextResponse.json({ funds: Array.isArray(funds) ? funds : [] });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || 'GLM_OCR_FAIL') }, { status: 500 });
  }
}
