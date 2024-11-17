import { PluginErrorType, createErrorResponse } from '@lobehub/chat-plugin-sdk';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

// 创建 XML 解析器实例
const parser = new XMLParser({
  attributeNamePrefix: '',
  ignoreAttributes: false
});

// 扩展查询参数接口
interface ArxivRequestData {
  // 搜索关键词
  maxResults?: number;
  query: string;
  // 结束年份
  searchField?: 'all' | 'title' | 'author' | 'abstract';
  // 最大返回结果数
  sortBy?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
  sortOrder?: 'ascending' | 'descending';          // 起始年份
  yearEnd?: number;
  yearStart?: number; // 搜索字段
}

// 扩展响应数据接口
interface ArxivPaper {
  authors: string[];
  categories: string[];
  doi?: string;
  id: string;
  journalRef?: string;
  pdfUrl: string;
  publishedDate: string;
  summary: string;
  title: string;
  updatedDate: string;
}

interface ArxivResponseData {
  nextCursor?: string;
  papers: ArxivPaper[];
  totalResults: number;
}

// 添加请求限流
const RATE_LIMIT = 3000; // 3秒间隔
let lastRequestTime = 0;

const rateLimit = async () => {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT) {
    await new Promise((resolve) => {
      setTimeout(resolve, RATE_LIMIT - timeSinceLastRequest);
    });
  }
  lastRequestTime = Date.now();
};

export const config = {
  runtime: 'edge',
};

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return createErrorResponse(PluginErrorType.MethodNotAllowed);
  }

  try {
    const {
      query,
      maxResults = 10,
      sortBy = 'relevance',
      sortOrder = 'descending',
      yearStart,
      yearEnd,
      searchField = 'all'
    } = (await req.json()) as ArxivRequestData;

    // 构建查询条件
    let searchQuery = '';
    switch (searchField) {
    case 'title': {
      searchQuery = `ti:${query}`;

    break;
    }
    case 'author': {
      searchQuery = `au:${query}`;

    break;
    }
    case 'abstract': {
      searchQuery = `abs:${query}`;

    break;
    }
    default: {
      searchQuery = `all:${query}`;
    }
    }

    // 添加年份过滤
    if (yearStart || yearEnd) {
      const dateQuery = [];
      if (yearStart) {
        dateQuery.push(`submittedDate:[${yearStart}0101 TO 99991231]`);
      }
      if (yearEnd) {
        dateQuery.push(`submittedDate:[00000101 TO ${yearEnd}1231]`);
      }
      if (dateQuery.length > 0) {
        searchQuery = `(${searchQuery}) AND (${dateQuery.join(' AND ')})`;
      }
    }

    // 构建 API URL
    const baseUrl = 'http://export.arxiv.org/api/query';
    const url = `${baseUrl}?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

    // 请求限流
    await rateLimit();

    // 发送请求
    const response = await axios.get(url);

    // 使用 fast-xml-parser 解析 XML
    const result = parser.parse(response.data);

    // 解析数据
    const entries = result.feed.entry || [];
    const papers = entries.map((entry: any): ArxivPaper => ({
      authors: Array.isArray(entry.author)
        ? entry.author.map((author: any) => author.name)
        : [entry.author.name],
      categories: Array.isArray(entry.category)
        ? entry.category.map((cat: any) => cat.term)
        : [entry.category.term],
      doi: entry['arxiv:doi'],
      id: entry.id,
      journalRef: entry['arxiv:journal_ref'],
      pdfUrl: entry.link.find((link: any) => link.title === 'pdf').href,
      publishedDate: entry.published,
      summary: entry.summary.trim(),
      title: entry.title.trim(),
      updatedDate: entry.updated
    }));

    const responseData: ArxivResponseData = {
      nextCursor: papers.length === maxResults ? String(maxResults) : undefined,
      papers,
      totalResults: Number.parseInt(result.feed['opensearch:totalResults'][0], 10)
    };

    return new Response(JSON.stringify(responseData), {
      headers: {
        'Cache-Control': 'max-age=3600',
        'Content-Type': 'application/json',
      },
    });

  } catch (error) {
    console.error('arXiv API Error:', error);
    return createErrorResponse(
      PluginErrorType.InternalServerError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
};
