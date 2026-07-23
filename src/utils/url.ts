export function listingUrl(id: string): string {
  return `https://m.bunjang.co.kr/products/${encodeURIComponent(id)}`;
}

export function listingActionUrl(id: string): string {
  return `https://m.bunjang.co.kr/products/${encodeURIComponent(id)}`;
}

// Direct URL for the talk (chat) inbox. Requires a desktop User-Agent: under the default
// mobile-web User-Agent this route has no discoverable nav entry point.
export function talkInboxUrl(): string {
  return 'https://m.bunjang.co.kr/talk';
}

export function searchUrl(query: string): string {
  return searchPageUrl(query, 1, 'score');
}

export function searchPageUrl(query: string, page: number, order: 'score' | 'date' | 'price_asc' | 'price_desc' = 'score'): string {
  const url = new URL('https://m.bunjang.co.kr/search/products');
  url.searchParams.set('order', order);
  url.searchParams.set('page', String(page));
  url.searchParams.set('q', query);
  return url.toString();
}
