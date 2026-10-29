'use strict';
// Configuración de las cabeceras: identidad visual + patrones de URL + selectores de cuerpo.
// Los patrones se escriben con String.raw para que los escapes lleguen intactos al navegador.

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MODERN = "'Avenir Next', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const PAPERS = [
  {
    slug: 'elmundo', name: 'El Mundo',
    front: 'https://www.elmundo.es/',
    color: '#0f2942', accent: '#b71234',
    fontHead: SERIF, fontBody: SERIF, uppercase: false,
    articleRe: String.raw`/20\d{2}/\d{2}/\d{2}/`,
    contentSelector: '.ue-l-article__body, .ue-c-article__body, [data-ue-mrf="articleBody"], article',
  },
  {
    slug: 'elconfidencial', name: 'El Confidencial',
    front: 'https://www.elconfidencial.com/',
    color: '#0b0b0f', accent: '#0e7a5f',
    fontHead: MODERN, fontBody: SANS, uppercase: false,
    articleRe: String.raw`/20\d{2}-\d{2}-\d{2}/`,
    contentSelector: '.article-body, .cuerpo-articulo, [data-article-body], article',
  },
  {
    slug: 'abc', name: 'ABC',
    front: 'https://www.abc.es/',
    color: '#00558c', accent: '#00558c',
    fontHead: SERIF, fontBody: SERIF, uppercase: false,
    articleRe: String.raw`-nt\.html$`,
    contentSelector: '.voc-d, .voc-d__content, .voc-detail-body, .articulo-cuerpo, .cuerpo-texto, article',
  },
  {
    slug: 'larazon', name: 'La Razón',
    front: 'https://www.larazon.es/',
    color: '#b3121b', accent: '#b3121b',
    fontHead: SERIF, fontBody: SERIF, uppercase: false,
    articleRe: String.raw`_20\d{6}[0-9a-f]{16,}\.html$`,
    contentSelector: '.cuerpo-noticia, .article-body, article',
  },
  {
    slug: 'eldebate', name: 'El Debate',
    front: 'https://www.eldebate.com/',
    color: '#8f1d22', accent: '#8f1d22',
    fontHead: SERIF, fontBody: SERIF, uppercase: false,
    articleRe: String.raw`/20\d{6}/.*_\d{5,}\.html$`,
    contentSelector: '.article-content, .entry-content, article',
  },
  {
    slug: 'theobjective', name: 'The Objective',
    front: 'https://theobjective.com/',
    color: '#16181d', accent: '#c8a45c',
    fontHead: SERIF, fontBody: SANS, uppercase: true,
    articleRe: String.raw`/20\d{2}-\d{2}-\d{2}/`,
    contentSelector: '.entry-content, .article-body, .post-content, article',
  },
  {
    slug: 'elpais', name: 'El País',
    front: 'https://elpais.com/',
    color: '#0b0b0b', accent: '#1a6fb5',
    fontHead: SERIF, fontBody: SERIF, uppercase: false,
    articleRe: String.raw`/20\d{2}-\d{2}-\d{2}/`,
    contentSelector: 'article [data-dtm-region="articulo_cuerpo"], .a_c, article',
  },
];

const bySlug = Object.fromEntries(PAPERS.map((p) => [p.slug, p]));

module.exports = { PAPERS, bySlug };
