# preParseTextbook2JSON

教材预解析模块——把 PDF / Markdown / TXT / DOCX / XLSX / CSV / TSV 等格式的教材,统一解析成带章节结构的 JSON,供下游 `parseEntityInTextbookJSON2VisualNode` 抽取知识点。

## 职责

- **多格式解析**:PDF(pdfjs-dist)、Word(mammoth)、Excel(xlsx)、纯文本(直接读)
- **章节识别**:正则匹配中文章节(`第N章`、`第N节`)和英文 `Chapter N`,Markdown 用 `#`/`##`/`###` 标题
- **结构化输出**:`{ textbookId, title, totalChars, chapters: [{ id, title, content, charCount, pageNumber }] }`
- **来源支持**:本地文件路径、HTTP/HTTPS URL、二进制 buffer(前端上传)

## 接口

### 编程式

```js
import { preParseTextbook2JSON } from "./index.mjs";

const textbook = await preParseTextbook2JSON({
  address: "/path/to/textbook.pdf",
  // 可选:textbookId 默认按 address 哈希
});
```

输入 `context` 支持两种形式:
- 字符串 → 当作 `{ address: <string> }`
- 对象 → `{ address, textbookId?, uploadBuffer? }`

### HTTP

挂在 `/api/preParseTextbook2JSON`,由 `src/backend/app/preParseTextbook2JSONRoutes.mjs` 注册:

```
POST /api/preParseTextbook2JSON/preParseTextbook2JSON
Body: { address, textbookId?, uploadBuffer? }
→ 200 { textbookId, title, totalChars, chapters: [...] }
```

## 支持的文件扩展名

| 扩展名 | 解析器 | 说明 |
|---|---|---|
| `.pdf` | `pdfjs-dist` | 流式读取,标准字体从 `node_modules/pdfjs-dist/standard_fonts/` 加载 |
| `.md` / `.markdown` | 内置 | 按 `#`/`##`/`###` 标题分章 |
| `.txt` | 内置 | 按 `第N章` / `Chapter N` 正则分章 |
| `.docx` | `mammoth` | 转 HTML 再提取文本 |
| `.xlsx` / `.xls` | `xlsx` | 按 sheet 分章 |
| `.csv` / `.tsv` | `xlsx` | 当作单 sheet |

不在列表内的扩展名会抛 `TypeError`。

## 输出 JSON 结构

```jsonc
{
  "textbookId": "book_03",          // 调用方指定,否则按 address 哈希
  "title": "...",                    // 文件名/首行/URL 推断
  "totalChars": 123456,
  "chapters": [
    {
      "id": "ch_001",
      "title": "第一章 绪论",
      "content": "...",              // 章节正文
      "charCount": 5432,
      "pageNumber": 1                // PDF 章节起始页,其他格式为 1
    }
  ]
}
```

## 测试

`tests/preParseTextbook2JSON.test.mjs` — 10 用例,覆盖 MD/TXT/PDF/DOCX/XLSX/URL 多格式、PDF 流式读取、真实中文教材、HTTP API、非法格式拒绝。

```bash
npm test -- --test-name-pattern="preParse"
```

## 相关

- 下游:[`parseEntityInTextbookJSON2VisualNode`](../parseEntityInTextbookJSON2VisualNode/) 消费本章 JSON,抽取知识点
- 设计:[docs/系统设计.md](../../../docs/系统设计.md)
- API 示例:[docs/API.md](../../../docs/API.md)
