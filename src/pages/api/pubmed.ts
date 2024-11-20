import { PluginErrorType, createErrorResponse } from '@lobehub/chat-plugin-sdk';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

// XML 解析器配置
const parser = new XMLParser({
  attributeNamePrefix: '',
  ignoreAttributes: false
});

// 请求参数接口
interface PubMedRequestData {
  maxResults?: number;
  query: string;
  sortBy?: 'relevance' | 'pub_date';
  yearEnd?: number;
  yearStart?: number;
}

// 论文数据接口
interface PubMedPaper {
  abstract?: string;
  authors: string[];
  doi?: string;
  journal: string;
  pmid: string;
  publishDate: string;
  title: string;
}

interface PubMedResponseData {
  papers: PubMedPaper[];
  totalResults: number;
}

// 请求限流设置
const RATE_LIMIT = 100; // 每秒10次请求 = 100ms 间隔
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

// 将 API key 移到环境变量中
const API_KEY = process.env.PUBMED_API_KEY || '6e4b525d4cde75d09925342b1681e66ef808';

export const config = {
  runtime: 'edge',
};

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return createErrorResponse(PluginErrorType.MethodNotAllowed);
  }

  try {
    const { query, maxResults = 10, sortBy = 'relevance', yearStart, yearEnd } =
      (await req.json()) as PubMedRequestData;

    // 构建查询条件
    let searchQuery = query;
    if (yearStart || yearEnd) {
      const dateFilter = [];
      if (yearStart) dateFilter.push(`${yearStart}[PDAT]`);
      if (yearEnd) dateFilter.push(`${yearEnd}[PDAT]`);
      searchQuery = `(${query}) AND (${dateFilter.join(' : ')})`;
    }

    // 构建 E-utilities URL
    const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
    const searchUrl = `${baseUrl}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchQuery)}&retmax=${maxResults}&sort=${sortBy === 'relevance' ? '' : 'pub_date'}&retmode=xml&api_key=${API_KEY}`;

    await rateLimit();
    const searchResponse = await axios.get(searchUrl);
    const searchResult = parser.parse(searchResponse.data);
    const pmids = searchResult.eSearchResult.IdList.Id;

    if (!pmids?.length) {
      return new Response(JSON.stringify({ papers: [], totalResults: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 获取详细信息
    const fetchUrl = `${baseUrl}/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml&api_key=${API_KEY}`;
    await rateLimit();
    const fetchResponse = await axios.get(fetchUrl);
    const fetchResult = parser.parse(fetchResponse.data);

    const papers = fetchResult.PubmedArticleSet.PubmedArticle.map((article: any) => {
      const medline = article.MedlineCitation;
      const articleData = medline.Article;

      // 处理 DOI
      let doi = '';
      if (Array.isArray(articleData.ELocationID)) {
        const doiLocation = articleData.ELocationID.find((id: any) => id.EIdType === 'doi');
        doi = doiLocation?._text || '';
      } else if (articleData.ELocationID?.EIdType === 'doi') {
        doi = articleData.ELocationID._text || '';
      }

      // 处理作者列表
      let authors: string[] = [];
      if (articleData.AuthorList?.Author) {
        const authorList = Array.isArray(articleData.AuthorList.Author)
          ? articleData.AuthorList.Author
          : [articleData.AuthorList.Author];
        authors = authorList.map((author: any) =>
          `${author.LastName || ''} ${author.ForeName || ''}`
        );
      }

      return {
        abstract: articleData.Abstract?.AbstractText || '',
        authors,
        doi,
        journal: articleData.Journal.Title,
        pmid: medline.PMID,
        publishDate: articleData.Journal.JournalIssue.PubDate.Year,
        title: articleData.ArticleTitle
      };
    });

    const responseData: PubMedResponseData = {
      papers,
      totalResults: Number(searchResult.eSearchResult.Count)
    };

    return new Response(JSON.stringify(responseData), {
      headers: {
        'Cache-Control': 'max-age=3600',
        'Content-Type': 'application/json',
      },
    });

  } catch (error) {
    console.error('PubMed API Error:', error);
    return createErrorResponse(
      PluginErrorType.InternalServerError,
      error instanceof Error ? error.message : '未知错误'
    );
  }
};
