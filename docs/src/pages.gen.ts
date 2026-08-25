// deno-fmt-ignore-file
// biome-ignore format: generated types do not need formatting
// prettier-ignore
import type { PathsForPages } from 'waku/router'

// prettier-ignore
type Page =
  | { path: '/architecture/operator'; render: 'static' }
  | { path: '/auctions/bid-lifecycle'; render: 'static' }
  | { path: '/auctions/fulfillment'; render: 'static' }
  | { path: '/concepts/encrypted-notes'; render: 'static' }
  | { path: '/how-whisper-works'; render: 'static' }
  | { path: '/'; render: 'static' }
  | { path: '/operations/development-status'; render: 'static' }
  | { path: '/security/privacy-and-trust'; render: 'static' }

// prettier-ignore
declare module 'waku/router' {
  interface RouteConfig {
    paths: PathsForPages<Page>
  }
  interface CreatePagesConfig {
    pages: Page
  }
}
