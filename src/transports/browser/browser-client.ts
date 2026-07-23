import { chromium, type Locator, type Page } from 'playwright';
import { SessionStore } from '../../config/session-store.js';
import {
  type ChatThread,
  type ChatThreadDetail,
  type ListingDetail,
  type ListingSummary,
  type PurchaseState,
  type SearchFilters,
  type SessionStatus,
} from '../../domain/models.js';
import type { BunjangTransport, Capability } from '../../domain/transport.js';
import { prompt } from '../../utils/cli-io.js';
import { parsePrice } from '../../utils/text.js';
import { listingActionUrl, listingUrl, searchPageUrl, talkInboxUrl } from '../../utils/url.js';
import { detectAuthenticatedSession } from './session-detection.js';

interface BrowserClientOptions {
  debug?: boolean;
}

class AuthRequiredError extends Error {
  constructor(message = 'Authenticated Bunjang session required.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

// Bunjang's mobile-web (m.bunjang.co.kr) pages are served with different component
// implementations depending on User-Agent sniffing: the default mobile UA renders an
// icon-only, app-nudge-cluttered layout that has no chat entry point at all, while a
// desktop UA on the same m.bunjang.co.kr URLs renders a fuller layout with a working
// "번개톡 대화하기" chat button / talk inbox route. Chat flows (list/start/read/send) use
// this UA (see `withPage`'s `desktop` option) so the talk.bunjang.co.kr iframe they depend
// on actually loads. See GitHub issue jinwon-int/bunjangcli#4.
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface WithPageOptions {
  desktop?: boolean;
}

const SEARCH_CARD_EVAL = () => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/products/"]')) as HTMLAnchorElement[];
  const seen = new Set<string>();
  return anchors.flatMap((anchor) => {
    const href = anchor.href;
    const match = href.match(/\/products\/(\d+)/);
    const id = match?.[1];
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const title =
      anchor.querySelector('div[class*="jpGcWM"], div[class*="title"], p')?.textContent?.trim() ||
      anchor.querySelector('img')?.getAttribute('alt') ||
      anchor.textContent?.trim() ||
      `Listing ${id}`;
    const imageUrl = anchor.querySelector('img')?.getAttribute('src') ?? null;
    const priceText =
      Array.from(anchor.querySelectorAll('div, span'))
        .map((node) => node.textContent?.trim() ?? '')
        .find((text) => /^[0-9][0-9,]{2,}$/.test(text)) ??
      anchor.querySelector('div[class*="gZIZmf"]')?.textContent?.trim() ??
      null;
    const metaText = Array.from(anchor.querySelectorAll('div, span'))
      .map((node) => node.textContent?.trim() ?? '')
      .find((text) => text.includes('전') || text.includes('서울') || text.includes('부산') || text.includes('경기') || text.includes('인천') || text.includes('지역정보 없음')) ?? null;
    const cardText = anchor.closest('article, li, div')?.textContent ?? anchor.textContent ?? '';
    return [{ id, href, title, imageUrl, priceText, metaText, cardText }];
  });
};

const DETAIL_EVAL = () => {
  const text = document.body.innerText;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meta = Object.fromEntries(
    Array.from(document.querySelectorAll('meta[property], meta[name]')).flatMap((node) => {
      const key = node.getAttribute('property') || node.getAttribute('name');
      const value = node.getAttribute('content');
      return key && value ? [[key, value]] : [];
    }),
  );
  const priceLineIndex = lines.findIndex((line) => /^[0-9][0-9,]*원$/.test(line));
  const title =
    (priceLineIndex > 0 ? lines[priceLineIndex - 1] : null) ||
    document.querySelector('h1')?.textContent?.trim() ||
    document.title ||
    'Unknown item';
  const imageUrl =
    (document.querySelector('img[src*="product/"]') as HTMLImageElement | null)?.src ||
    (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content ||
    null;

  const section = (label: string, nextLabels: string[]) => {
    const start = lines.indexOf(label);
    if (start === -1) return [];
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (nextLabels.includes(lines[index])) {
        end = index;
        break;
      }
    }
    return lines.slice(start + 1, end).filter(Boolean);
  };

  const descriptionLines = section('상품정보', ['직거래지역', '카테고리', '상품태그', '비슷한 새 상품 보기', '상점정보']);
  const locationLines = section('직거래지역', ['카테고리', '상품태그', '비슷한 새 상품 보기', '상점정보']);
  const categoryLines = section('카테고리', ['상품태그', '비슷한 새 상품 보기', '상점정보']).filter((line) => line !== '>');
  const tags = section('상품태그', ['비슷한 새 상품 보기', '상점정보']).filter((line) => line.startsWith('#'));
  const sellerLines = section('상점정보', ['상품 더보기', '상점후기', '번개톡', '바로구매', '파워링크', '회사소개']);
  const statusLines = section('상품상태', ['배송비', '직거래지역', '상품정보', '카테고리']);
  const shippingFeeLines = section('배송비', ['직거래지역', '상품정보', '카테고리']);
  const favoriteCountLines = section('찜', ['번개톡', '바로구매', '안전결제 수수료 없이 구매하세요']);

  const sellerItemCountText = sellerLines.find((line) => /^상품\d+/.test(line)) ?? '';
  const sellerReviewCountMatch = text.match(/상점후기(\d+)/);

  return {
    title,
    description: descriptionLines.join('\n'),
    priceText: priceLineIndex >= 0 ? lines[priceLineIndex] : '',
    imageUrl,
    location: locationLines[0] ?? '',
    category: categoryLines.join(' > '),
    tags,
    sellerName: sellerLines[0] ?? '',
    sellerItemCountText,
    sellerReviewCountText: sellerReviewCountMatch?.[1] ?? '',
    status: statusLines[0] ?? '',
    shippingFee: shippingFeeLines[0] ?? '',
    favoriteCountText: favoriteCountLines[0] ?? '',
    meta,
    text,
  };
};

export class BrowserClient implements BunjangTransport {
  readonly name = 'browser' as const;
  private readonly store: SessionStore;
  private readonly debug: boolean;

  constructor(store = new SessionStore(), options: BrowserClientOptions = {}) {
    this.store = store;
    this.debug = options.debug ?? false;
  }

  async supports(_capability: Capability): Promise<boolean> {
    return true;
  }

  async loginInteractive(): Promise<SessionStatus> {
    this.store.ensure();
    const context = await chromium.launchPersistentContext(this.store.userDataDir, {
      headless: false,
      viewport: { width: 430, height: 932 },
      locale: 'ko-KR',
      // Force Chromium's portable cookie-encryption backend instead of an OS keyring
      // (gnome-keyring/kwallet/macOS Keychain). Without this, a profile logged in on a
      // machine with a keyring can have its cookies silently fail to decrypt after being
      // copied to a different machine via `auth export`/`auth import` (e.g. a headless
      // server with no keyring service) — the profile looks intact but reports logged out.
      args: ['--password-store=basic'],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://m.bunjang.co.kr/login', { waitUntil: 'domcontentloaded' });
    console.error('A headful Bunjang browser has been opened. Please complete login manually.');
    await prompt('Press Enter here after login is complete... ', true);
    await this.softSettle(page);
    const verification = await this.detectSession(page);
    if (!verification.authenticated) {
      await context.close();
      throw new Error(`Login could not be verified (${verification.detectedBy}). Please complete login and retry.`);
    }
    this.store.saveMetadata({ lastLoginAt: new Date().toISOString(), lastTransport: 'browser' });
    await context.close();
    return this.getSessionStatus();
  }

  async getSessionStatus(): Promise<SessionStatus> {
    const metadata = this.store.readMetadata();
    if (!this.store.profileExists() || metadata.lastLoginAt === null) {
      return {
        authenticated: false,
        profileExists: this.store.profileExists(),
        userDataDir: this.store.userDataDir,
        metadataPath: this.store.metadataPath,
        headfulLoginRequired: true,
        lastLoginAt: metadata.lastLoginAt,
        detectedBy: 'missing-session-metadata',
      };
    }
    const context = await chromium.launchPersistentContext(this.store.userDataDir, {
      headless: true,
      viewport: { width: 430, height: 932 },
      locale: 'ko-KR',
      args: ['--password-store=basic'],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://m.bunjang.co.kr/', { waitUntil: 'domcontentloaded' });
    await this.softSettle(page);
    const verification = await this.detectSession(page);
    await context.close();
    return {
      authenticated: verification.authenticated,
      profileExists: this.store.profileExists(),
      userDataDir: this.store.userDataDir,
      metadataPath: this.store.metadataPath,
      headfulLoginRequired: !verification.authenticated,
      lastLoginAt: metadata.lastLoginAt,
      detectedBy: verification.detectedBy,
    };
  }

  async search(query: string, filters: SearchFilters): Promise<ListingSummary[]> {
    return this.withPage(false, async (page) => {
      const startPage = filters.startPage ?? 1;
      const totalPages = filters.pages ?? 1;
      const order = filters.sort ?? 'score';
      const deduped = new Map<string, ListingSummary>();
      for (let pageNumber = startPage; pageNumber < startPage + totalPages; pageNumber += 1) {
        await page.goto(searchPageUrl(query, pageNumber, order), { waitUntil: 'domcontentloaded' });
        await this.softSettle(page);
        const rawCards = await page.evaluate(SEARCH_CARD_EVAL);
        for (const card of rawCards) {
          const price = parsePrice(card.priceText ?? card.cardText);
          const item: ListingSummary = {
            id: card.id,
            title: card.title.trim(),
            url: card.href.startsWith('http') ? card.href : `https://m.bunjang.co.kr${card.href}`,
            price,
            currency: 'KRW',
            imageUrl: card.imageUrl,
            location: card.metaText,
            transportUsed: 'browser',
            raw: { text: card.cardText, priceText: card.priceText, metaText: card.metaText, page: pageNumber },
          };
          if (this.matchesFilters(item.price, filters) && !deduped.has(item.id)) {
            deduped.set(item.id, item);
          }
          if (deduped.size >= (filters.maxItems ?? 20)) {
            break;
          }
        }
        if (deduped.size >= (filters.maxItems ?? 20) || rawCards.length === 0) {
          break;
        }
      }
      return Array.from(deduped.values()).slice(0, filters.maxItems ?? 20);
    });
  }

  async getItem(id: string): Promise<ListingDetail> {
    return this.withPage(false, async (page) => {
      await page.goto(listingUrl(id), { waitUntil: 'domcontentloaded' });
      await this.softSettle(page);
      const data = await page.evaluate(DETAIL_EVAL);
      return {
        id,
        title: data.title,
        url: page.url(),
        price: parsePrice(data.priceText),
        currency: 'KRW',
        imageUrl: data.imageUrl,
        description: data.description,
        location: data.location || null,
        category: data.category || null,
        status: data.status || null,
        shippingFee: data.shippingFee || null,
        sellerName: data.sellerName || null,
        sellerItemCount: this.parseFavoriteCount(data.sellerItemCountText),
        sellerReviewCount: this.parseFavoriteCount(data.sellerReviewCountText),
        tags: data.tags,
        favoriteCount: this.parseFavoriteCount(data.favoriteCountText),
        transportUsed: 'browser',
        metadata: Object.fromEntries(
          Object.entries(data.meta).map(([key, value]) => [key, String(value)]),
        ),
      };
    });
  }

  async getItems(ids: string[]): Promise<ListingDetail[]> {
    const results: ListingDetail[] = [];
    for (const id of ids) {
      results.push(await this.getItem(id));
    }
    return results;
  }

  async listChats(): Promise<ChatThread[]> {
    return this.withPage(
      true,
      async (page) => {
        await this.openTalkInbox(page);
        return this.extractChatThreads(page);
      },
      { desktop: true },
    );
  }

  async startChat(listingId: string, message: string): Promise<ChatThreadDetail> {
    return this.withPage(
      true,
      async (page) => {
        // Navigating straight to `<listing>?talk=true` on a hard page load does NOT
        // reliably open the talk iframe (confirmed by direct testing: the site only opens
        // it in response to a client-side route transition, i.e. an actual click). So
        // click the contact button instead of constructing that URL directly.
        await this.gotoAuthenticated(page, listingActionUrl(listingId));
        const contactButton = await this.findContactButton(page);
        await contactButton.click({ force: true, timeout: 10000 });
        await page.waitForTimeout(2500);
        const frame = await this.getTalkFrame(page);
        await this.dismissTalkNotices(frame);
        const thread = await this.extractActiveThread(frame);
        await this.sendMessageInFrame(frame, message);
        return this.extractActiveThread(frame, message, thread);
      },
      { desktop: true },
    );
  }

  async readChat(threadId: string): Promise<ChatThreadDetail> {
    return this.withPage(
      true,
      async (page) => {
        const frame = await this.openTalkInbox(page);
        await this.selectThreadInFrame(frame, threadId);
        return this.extractActiveThread(frame);
      },
      { desktop: true },
    );
  }

  async sendChat(threadId: string, message: string): Promise<ChatThreadDetail> {
    return this.withPage(
      true,
      async (page) => {
        const frame = await this.openTalkInbox(page);
        await this.selectThreadInFrame(frame, threadId);
        await this.sendMessageInFrame(frame, message);
        return this.extractActiveThread(frame, message);
      },
      { desktop: true },
    );
  }

  async listFavorites(): Promise<ListingSummary[]> {
    return this.withPage(true, async (page) => {
      await this.navigateViaNavText(page, ['찜', '관심']);
      await this.softSettle(page);
      const items = await page.evaluate(SEARCH_CARD_EVAL);
      return items.map((card) => ({
        id: card.id,
        title: card.title.trim(),
        url: card.href,
        price: parsePrice(card.cardText),
        currency: 'KRW',
        imageUrl: card.imageUrl,
        transportUsed: 'browser',
        raw: { text: card.cardText },
      }));
    });
  }

  async addFavorite(listingId: string): Promise<ListingDetail> {
    return this.toggleFavorite(listingId, ['찜', '관심'], true);
  }

  async removeFavorite(listingId: string): Promise<ListingDetail> {
    return this.toggleFavorite(listingId, ['찜해제', '찜 취소', '관심 해제', '관심취소', '찜', '관심'], false);
  }

  async preparePurchase(listingId: string): Promise<PurchaseState> {
    return this.withPage(true, async (page) => {
      await page.goto(listingUrl(listingId), { waitUntil: 'domcontentloaded' });
      await this.softSettle(page);
      const available = await page.getByRole('button', { name: /구매|안전결제|결제/i }).first().isVisible().catch(() => false);
      return {
        listingId,
        available,
        stage: available ? 'item-page' : 'unavailable',
        nextAction: available ? 'Run purchase start to open the purchase flow.' : 'No purchase button detected.',
        requiresUserConfirmation: true,
        transportUsed: 'browser',
      };
    });
  }

  async startPurchase(listingId: string): Promise<PurchaseState> {
    return this.withPage(true, async (page) => {
      await page.goto(listingUrl(listingId), { waitUntil: 'domcontentloaded' });
      await this.softSettle(page);
      const button = page.getByRole('button', { name: /구매|안전결제|결제/i }).first();
      const available = await button.isVisible().catch(() => false);
      if (!available) {
        return {
          listingId,
          available: false,
          stage: 'unavailable',
          nextAction: 'No purchase button detected on the item page.',
          requiresUserConfirmation: true,
          transportUsed: 'browser',
        };
      }
      await button.click();
      await this.softSettle(page);
      return {
        listingId,
        available: true,
        stage: 'ready-for-manual-confirmation',
        nextAction: 'Purchase flow opened. Review the page manually; v1 intentionally stops before automatic confirmation.',
        requiresUserConfirmation: true,
        transportUsed: 'browser',
        raw: { url: page.url() },
      };
    });
  }

  private async toggleFavorite(listingId: string, labels: string[], shouldBeFavorited: boolean): Promise<ListingDetail> {
    return this.withPage(true, async (page) => {
      await this.gotoAuthenticated(page, listingActionUrl(listingId));
      const locator = await this.findFavoriteButton(page, labels);
      const favoriteTextBefore = await locator.textContent().catch(() => null);
      const favoritedBefore = await this.isFavoriteButtonActive(locator);
      await locator.click();
      await this.softSettle(page);
      let favoriteTextAfter = await locator.textContent().catch(() => null);
      let favoritedAfter = await this.isFavoriteButtonActive(locator);
      const beforeCount = this.parseFavoriteCount(favoriteTextBefore);
      const afterCount = this.parseFavoriteCount(favoriteTextAfter);
      const needsSecondToggleByCount =
        beforeCount !== null &&
        afterCount !== null &&
        ((shouldBeFavorited && afterCount < beforeCount) || (!shouldBeFavorited && afterCount > beforeCount));
      // The current icon-only bookmark button carries no visible text/count, so
      // needsSecondToggleByCount is always false for it (both counts are null). Fall back
      // to its filled/outline state, which we can read directly off the inner <svg fill>.
      const needsSecondToggleByState = favoritedAfter !== null && favoritedAfter !== shouldBeFavorited;
      if (needsSecondToggleByCount || needsSecondToggleByState) {
        await locator.click();
        await this.softSettle(page);
        favoriteTextAfter = await locator.textContent().catch(() => null);
        favoritedAfter = await this.isFavoriteButtonActive(locator);
      }
      const detail = await this.getItem(listingId);
      return {
        ...detail,
        raw: {
          ...(detail.raw ?? {}),
          favoriteTextBefore,
          favoriteTextAfter,
          favoritedBefore,
          favoritedAfter,
        },
      };
    });
  }

  /**
   * Reads favorited/not-favorited state directly off the bookmark button's inner `<svg
   * fill="...">` (empty/"none" = outline/not-favorited, a set color = filled/favorited).
   * Returns null when there's no inspectable svg, so callers can fall back to other
   * signals (e.g. visible text/count) instead of treating "unknown" as "not favorited".
   */
  private async isFavoriteButtonActive(locator: Locator): Promise<boolean | null> {
    const fill = await locator.locator('svg').first().getAttribute('fill').catch(() => null);
    if (fill === null) return null;
    return fill !== '' && fill.toLowerCase() !== 'none';
  }

  private matchesFilters(price: number | null, filters: SearchFilters): boolean {
    if (filters.priceMin !== undefined && (price === null || price < filters.priceMin)) return false;
    if (filters.priceMax !== undefined && (price === null || price > filters.priceMax)) return false;
    return true;
  }

  private async withPage<T>(
    requireSession: boolean,
    run: (page: Page) => Promise<T>,
    opts: WithPageOptions = {},
  ): Promise<T> {
    return this.withPageAttempt(requireSession, run, 0, opts);
  }

  private async softSettle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(400);
  }

  private async navigateViaNavText(page: Page, labels: string[]): Promise<string> {
    await this.gotoAuthenticated(page, 'https://m.bunjang.co.kr/');
    for (const label of labels) {
      const exact = page.getByRole('link', { name: new RegExp(label) }).first();
      if (await exact.isVisible().catch(() => false)) {
        await exact.click();
        await this.softSettle(page);
        return page.url();
      }
      const button = page.getByRole('button', { name: new RegExp(label) }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await this.softSettle(page);
        return page.url();
      }
    }
    throw new Error(`Unable to find navigation entry for labels: ${labels.join(', ')}`);
  }

  private async openTalkInbox(page: Page) {
    // Requires the desktop User-Agent (see `withPage`'s `desktop` option): under the
    // default mobile UA, m.bunjang.co.kr/talk has no nav entry point and this route
    // doesn't render the talk.bunjang.co.kr iframe at all.
    await this.gotoAuthenticated(page, talkInboxUrl());
    await page.waitForTimeout(2500);
    const frame = await this.getTalkFrame(page);
    await this.dismissTalkNotices(frame);
    return frame;
  }

  private async withPageAttempt<T>(
    requireSession: boolean,
    run: (page: Page) => Promise<T>,
    attempt: number,
    opts: WithPageOptions = {},
  ): Promise<T> {
    if (requireSession && attempt === 0) {
      const status = await this.getSessionStatus();
      if (!status.authenticated) {
        await this.loginInteractive();
        return this.withPageAttempt(requireSession, run, attempt + 1, opts);
      }
    }
    this.store.ensure();
    const context = await chromium.launchPersistentContext(this.store.userDataDir, {
      headless: true,
      viewport: opts.desktop ? { width: 1280, height: 900 } : { width: 430, height: 932 },
      locale: 'ko-KR',
      args: ['--password-store=basic'],
      ...(opts.desktop ? { userAgent: DESKTOP_USER_AGENT } : {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      if (this.debug) {
        page.on('console', (msg) => console.error('[browser]', msg.text()));
      }
      if (requireSession) {
        await page.goto('https://m.bunjang.co.kr/', { waitUntil: 'domcontentloaded' });
        await this.softSettle(page);
        const verification = await this.detectSession(page);
        if (!verification.authenticated) {
          throw new AuthRequiredError(`Session is not authenticated (${verification.detectedBy}).`);
        }
      }
      return await run(page);
    } catch (error) {
      if (error instanceof AuthRequiredError && attempt < 1) {
        await context.close();
        await this.loginInteractive();
        return this.withPageAttempt(requireSession, run, attempt + 1, opts);
      }
      throw error;
    } finally {
      await context.close();
    }
  }

  private async gotoAuthenticated(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.softSettle(page);
    await this.dismissAppNudge(page);
    // A listing that's been sold/paused/taken down renders a "숨겨진 상품입니다" (hidden
    // item) placeholder with unrelated "similar products" content instead of a 404. Without
    // this check, downstream steps (finding the favorite/contact button, reading the talk
    // frame) fail with a confusing, unrelated error instead of surfacing the real cause.
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (bodyText.includes('숨겨진 상품입니다')) {
      throw new Error(`Listing is hidden or no longer available on Bunjang: ${url}`);
    }
    const verification = await this.detectSession(page);
    if (!verification.authenticated) {
      throw new AuthRequiredError(`Authentication required after navigating to ${url} (${verification.detectedBy}).`);
    }
  }

  /**
   * Bunjang shows a mobile-web page a "번개장터 앱으로 시작하기 / 괜찮아요, 모바일 웹에서 볼게요"
   * bottom-sheet nudge to install the app. It sits in a `bun-ui-portal` overlay with a dim
   * backdrop that intercepts clicks on anything underneath it (the favorite/bookmark
   * button, nav links, etc.) until dismissed. Every authenticated navigation goes through
   * `gotoAuthenticated`, so dismissing it here covers favorite/nav/purchase flows in one
   * place rather than repeating this in each caller.
   */
  private async dismissAppNudge(page: Page): Promise<void> {
    const dismiss = page.getByText('괜찮아요, 모바일 웹에서 볼게요').first();
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click({ force: true }).catch(() => {
        // best effort — if the nudge closes on its own or the click misses, callers still
        // proceed and may hit their own timeout/selector errors, which is no worse than
        // today's behavior without this dismissal.
      });
      await page.waitForTimeout(300);
    }
  }

  private async detectSession(page: Page) {
    const [bodyText, cookies] = await Promise.all([
      page.locator('body').innerText().catch(() => ''),
      page.context().cookies(),
    ]);
    return detectAuthenticatedSession({
      url: page.url(),
      bodyText,
      cookieNames: cookies.map((cookie) => cookie.name),
    });
  }

  private async getTalkFrame(page: Page) {
    await page.waitForTimeout(1000);
    const frame = page.frames().find((candidate) => candidate.url().startsWith('https://talk.bunjang.co.kr/'));
    if (!frame) {
      throw new Error('Unable to locate talk frame.');
    }
    return frame;
  }

  private async dismissTalkNotices(frame: Page | import('playwright').Frame) {
    const confirm = frame.getByRole('button', { name: '확인했어요' }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click({ force: true });
      await frame.waitForTimeout(300);
    }
  }

  private async extractChatThreads(page: Page): Promise<ChatThread[]> {
    const frame = await this.getTalkFrame(page);
    const cards = frame.locator('div[class*="e93e7277-0"]');
    const count = Math.min(await cards.count(), 20);
    const threads: ChatThread[] = [];
    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const text = (await card.innerText().catch(() => '')).trim();
      if (!text || text.includes('전체 대화')) continue;
      await card.click({ force: true });
      await frame.waitForTimeout(200);
      const id = this.extractThreadId(frame.url()) ?? `thread-${i + 1}`;
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      threads.push({
        id,
        title: lines[0] ?? `Chat ${i + 1}`,
        lastMessage: lines[1] ?? null,
        participants: lines[0] ? [lines[0]] : [],
        url: frame.url(),
        transportUsed: 'browser',
      });
    }
    return threads;
  }

  private extractThreadId(url: string): string | null {
    const match = url.match(/\/user\/([^?]+)/);
    return match?.[1] ?? null;
  }

  private async selectThreadInFrame(frame: import('playwright').Frame, threadId: string) {
    const cards = frame.locator('div[class*="e93e7277-0"]');
    const count = await cards.count();
    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const text = (await card.innerText().catch(() => '')).trim();
      if (!text || text.includes('전체 대화')) continue;
      await card.click({ force: true });
      await frame.waitForTimeout(200);
      const currentId = this.extractThreadId(frame.url());
      if (currentId === threadId || text.includes(threadId)) {
        return;
      }
    }
    throw new Error(`Unable to locate thread ${threadId} in talk inbox.`);
  }

  private async extractActiveThread(
    frame: import('playwright').Frame,
    sentMessage?: string,
    fallback?: Partial<ChatThreadDetail>,
  ): Promise<ChatThreadDetail> {
    const data = await frame.evaluate(() => {
      const body = document.body.innerText;
      const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
      const title = document.querySelector('strong')?.textContent?.trim() ?? lines.find((line) => /전 접속|구매하기/.test(line)) ?? 'Talk thread';
      const messages = lines.slice(-30).map((body, index) => ({ id: String(index + 1), body }));
      return { body, title, messages };
    });
    const title = typeof fallback?.title === 'string' && fallback.title ? fallback.title : data.title;
    const id = this.extractThreadId(frame.url()) ?? fallback?.id ?? 'unknown';
    const messages = sentMessage && !data.messages.some((message) => message.body.includes(sentMessage))
      ? [...data.messages, { id: String(data.messages.length + 1), body: sentMessage }]
      : data.messages;
    return {
      id,
      title,
      participants: title ? [title] : [],
      url: frame.url(),
      transportUsed: 'browser',
      messages,
    };
  }

  private async sendMessageInFrame(frame: import('playwright').Frame, message: string) {
    await this.dismissTalkNotices(frame);
    const input = frame.locator('textarea[placeholder="메시지를 입력하세요."]').first();
    await input.click({ timeout: 10000 });
    await input.fill(message);
    await frame.waitForTimeout(200);
    await input.press('Enter');
    await frame.waitForTimeout(1200);
  }

  /**
   * The chat/contact button only exists in the desktop-UA-rendered layout (see
   * `withPage`'s `desktop` option / DESKTOP_USER_AGENT) — under the default mobile UA the
   * bottom action bar has no chat entry at all, only a favorite icon and an app-store
   * deep link. `aria-label="번개톡 대화하기"` is the current (2026-07) desktop selector;
   * the older class-based selectors are kept as a defensive fallback in case a future
   * redesign reintroduces a text-based mobile button.
   */
  private async findContactButton(page: Page) {
    const locators = [
      page.locator('button[aria-label="번개톡 대화하기"]').first(),
      page.locator('button[class*="ProductSummarystyle__ContactButton"]').first(),
      page.locator('button[class*="ContactButton"]').filter({ hasText: /^번개톡$/ }).first(),
      page.locator('button').filter({ hasText: /^번개톡$/ }).nth(1),
      page.locator('button').filter({ hasText: /^번개톡$/ }).first(),
    ];
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    throw new Error('Unable to find product contact button.');
  }

  private async findFavoriteButton(page: Page, labels: string[]) {
    const locators = [
      // Current site build (2026-07 redesign): CSS-module class like
      // `_bookmarkButton_8y4nl_19`, an icon-only button with no visible text, fixed to
      // the bottom action bar. `[class*="..." i]` is a case-insensitive CSS attribute
      // match, since the exact casing isn't a stable contract either.
      page.locator('button[class*="bookmarkButton" i]').first(),
      // Older build: a class literally containing "FavoriteButton". Kept as a fallback
      // in case a future redesign reverts naming or an intermediate build differs.
      page.locator('button[class*="FavoriteButton"]').first(),
      page.locator('button').filter({ hasText: new RegExp(labels.join('|')) }).first(),
    ];
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    throw new Error('Unable to find favorite button.');
  }

  private parseFavoriteCount(text: string | null): number | null {
    if (!text) return null;
    const digits = text.replace(/[^0-9]/g, '');
    return digits ? Number(digits) : null;
  }
}
