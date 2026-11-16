# RSS 2.0 and Atom feeds

One adapter (`FeedAdapter`, source id `rss`) reads any RSS 2.0 or Atom feed given as a `FeedRef` (`id`, `url`, `name`).

| Format | Elements Reckon relies on |
| --- | --- |
| RSS 2.0 | `rss > channel > item`: `title`, `link` (else a `guid` that is a URL and not `isPermaLink="false"`), `pubDate` (RFC 822; `dc:date` as fallback), `description`; `channel > language` |
| Atom | `feed > entry`: `title` (text or `{#text, @type}`), `link` (`@href`; `rel="alternate"` or no `rel` preferred), `published` else `updated`, `summary` else `content`; `feed@xml:lang` |

Request and parsing rules:

- `Accept: application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8`; `If-None-Match` / `If-Modified-Since` from the stored `etag` / `lastModified`. A 304 is `{ notModified: true }`; otherwise the snapshot comes back with the response `etag` and `last-modified` headers (null if absent). Snapshot `contentType` is the response's, else `application/xml`.
- Items without a title or an `http(s)` link are skipped; at most 100 items are read per feed. `source` is `FeedRef.name`; `publishedAt` is ISO 8601 or null when unparseable.
- Titles and snippets are HTML-stripped and entity-decoded. Snippets collapse whitespace and are cut to ≤ 280 characters on a word boundary with `…`; a WordPress `[…]` trailer becomes `…`.
- The document must be well-formed XML (`XMLValidator`); anything else, a truncated body, or a document that is neither `rss` nor `feed` is `schema_changed` (detail prefixed with the feed id). A feed with a bare `&` is rejected rather than half-read.
- Entity safety (fast-xml-parser 5): DOCTYPE entities are capped (`maxEntityCount` 20, `maxTotalExpansions` 100, `maxExpandedLength` 10 000; nested references are not expanded) and external entities (`SYSTEM`) make the parser throw, which becomes `schema_changed`. HTML entities are decoded by the adapter in one pass, never by the parser.

| Item | Value |
| --- | --- |
| Auth | None |
| Limits | No published rate limits; fetch each feed no more often than its `<ttl>` (BBC 15 min, The Hindu 60 min) and always conditionally |
| Fixtures | `packages/adapters/test/fixtures/rss-bbc-world.xml` (BBC News World, recorded 2026-10-05, trimmed to 3 items), `atom-verge.xml` (The Verge, recorded 2026-10-05, trimmed to 3 entries) |
| Contract test | `packages/adapters/test/news-sources.contract.test.ts` (run with `pnpm test:contracts`); all six default feeds passed on 2026-10-05 |

## Default feeds and reuse terms

Reckon's use: single user, non-commercial; shows only headline, source, time, link and a ≤ 280-character snippet, always linking to the publisher. Terms pages were fetched on 2026-10-05; quotes are verbatim. This is a reading of the terms, not legal advice.

| Feed | URL | Format | Terms found | Verdict |
| --- | --- | --- | --- | --- |
| BBC News – World | `https://feeds.bbci.co.uk/news/world/rss.xml` | RSS 2.0 (`en-gb`) | Feed `<copyright>` points to https://www.bbc.co.uk/usingthebbc/terms-of-use/#15metadataandrssfeeds. §15a "For people": "You can add the BBC News RSS feed to your website or social media account. Provided: You don't change the RSS feed or remove any of our branding … You credit us by saying it's from BBC News, bbc.co.uk/news or bbc.com/news putting the text and hyperlink in a prominent place nearby"; also "You're not allowed to pluck metadata from our content or RSS feeds." §15b: business use needs permission. | **Compatible with care**: label items "BBC News" with a link; show descriptions unaltered (BBC descriptions are short, so the 280 cut rarely applies). The "pluck metadata" sentence is ambiguous for storing headlines; keep storage to what is displayed. |
| BBC News – Technology | `https://feeds.bbci.co.uk/news/technology/rss.xml` | RSS 2.0 | Same BBC terms as above. | Same as above. |
| The Hindu – Economy | `https://www.thehindu.com/business/Economy/feeder/default.rss` | RSS 2.0 (`en-US`) | https://www.thehindu.com/termsofuse/: "We permit the use of materials on this website subject to due credit is given to THG PUBLISHING PRIVATE LIMITED. The use shall also be subject to non-commercial use and limited to personal or academic dissemination"; grants a right "to create hyperlinks to the home page or any other page"; but also "THG PUBLISHING PRIVATE LIMITED prohibits caching, unauthorized hypertext links to the Site & the framing of any Content". The RSS page (https://www.thehindu.com/rssfeeds/) says clicking the RSS button means agreeing to "these T&C" but does not show separate RSS terms. | **Compatible with care**: personal, non-commercial, credited ("The Hindu") and linked. The "prohibits caching" clause conflicts on its face with keeping headlines; keep only what is shown and expire it. |
| Ars Technica | `https://feeds.arstechnica.com/arstechnica/index` | RSS 2.0 (`en-US`) | arstechnica.com/rss-feeds/ was behind a bot check (HTTP 405). Condé Nast User Agreement (https://www.condenast.com/user-agreement): "the Service is intended for your personal, non-commercial use only"; RSS content may be used "only to the extent expressly authorized"; prohibits "any other automated process, or engage in meta-searching or periodic caching of information" and to "store, or republish any Content … for any purpose related to … the training, development, testing, fine-tuning, improvement, grounding (including through RAG) or operation of any software or service … that incorporates a large language model". | **Flagged — likely incompatible.** Periodic automated fetching and storage are prohibited on the face of the text, and the Phase 4 `llm.evidence` forecaster would be "grounding" an LLM. If kept, never pass Ars items to an LLM; better to drop the feed or ask Condé Nast. |
| NASA – News releases | `https://www.nasa.gov/news-release/feed/` | RSS 2.0 (`en-US`) | https://www.nasa.gov/nasa-brand-center/images-and-media/: NASA content "generally are not subject to copyright in the United States"; may be used "for educational or informational purposes, including … Internet Web pages. This general permission extends to personal Web pages"; "NASA should be acknowledged as the source"; must not imply endorsement; third-party images may be copyrighted. | **Compatible**: credit "NASA"; Reckon shows no images. |
| The Verge | `https://www.theverge.com/rss/index.xml` | Atom (`en-US`) | Vox Media terms (https://www.voxmedia.com/terms-of-use/): may not "make any commercial use of (other than to keep and share information for your own non-commercial purposes) any content"; but also may not use "any 'robot,' 'spider,' 'rover,' 'scraper' or any other data-mining technology or automatic or manual process to monitor, cache, frame, mask, extract data from, copy or distribute any data from the Services". No RSS-specific terms found (`/rss/index.html` is 404). | **Compatible with care**: the "own non-commercial purposes" carve-out fits; the anti-automation clause is broad but the feed is published for feed readers. Credit "The Verge" and link. |

Last verified: 2026-10-05 (all six feeds fetched live and parsed by the contract test).
