// The public tik API, injected by the host before any page script: no import,
// no setup, always present.
//
// Generated file: rewritten from the platform's definition, so edits here are
// lost and change nothing at runtime.
declare global {
  interface TikApi {
    /** API version of the injected surface. */
    readonly version: string;

    /** This tik's id, stable for the life of the document. */
    tikId(): string;

    /**
     * Who MADE this tik (the viewer is `profile()`), always present. Display
     * only: a forked copy can say anything, so it never proves who someone is.
     * Baked at document start, like `tikId()`.
     */
    author(): {
      username: string;
      avatarUrl: string | null;
      /** The author's public profile page, `<site>/u/<username>`. */
      link: string;
    };

    /**
     * Is the user looking at this document right now? The feed boots tiks and
     * slides BEFORE you reach them, and `document.hidden` stays false off
     * screen. Run loops, timers and sound only while visible. The value is
     * right at first paint and events fire only on later changes, so read it
     * AND subscribe:
     *
     *     if (tik.visible()) start();
     *     tik.on('visible', start);
     *     tik.on('hidden', pause);
     */
    visible(): boolean;

    /**
     * This tik's own SpacetimeDB database; absent without the
     * `options.spacetimedb` grant, so presence is the feature test:
     *
     *     if (tik.spacetimedb) {
     *       const { url, database } = await tik.spacetimedb();
     *     }
     *
     * A promise because the host may provision first. Never hardcode either
     * value: both differ per environment, and the name derives from the tik's
     * identity.
     */
    spacetimedb?(): Promise<{ url: string; database: string }>;

    /**
     * The signed-in viewer's public profile; absent without the
     * `permissions.profile` grant or when nobody is signed in, so presence is
     * the feature test:
     *
     *     if (tik.profile) {
     *       const me = await tik.profile();   // { username, avatarUrl }
     *     }
     *
     * Without a backend it needs nothing else. It is page data, display only:
     * a module cannot trust it. With `options.spacetimedb` the grant also turns
     * on `tik.token()`, which carries the same name and avatar as SIGNED
     * claims; a module reads them from there.
     */
    profile?(): Promise<{
      username: string;
      avatarUrl: string | null;
      /** The viewer's public profile page, `<site>/u/<username>`. */
      link: string;
    }>;

    /**
     * A short-lived token identifying the viewer to this tik's own SpacetimeDB
     * module; absent unless the tik has a backend AND the profile/auth grant,
     * so presence is the feature test:
     *
     *     if (tik.token) {
     *       const token = await tik.token();
     *     }
     *
     * Call it per connection and never cache it (it expires; the host caches
     * it while valid). Send it to your own module only: every other database
     * refuses it. When the host cannot mint one it rejects with
     * `.code === 'unavailable'` and the reason in `.message`: treat the viewer
     * as anonymous. An anonymous viewer gets a fresh SpacetimeDB identity per
     * connection, so nothing survives a reload.
     */
    token?(): Promise<string>;

    /**
     * Users who opened this tik, author first; present with `tik.token`.
     * Answers the author, or anyone with `options.publicUsers`; else rejects
     * `.code === 'unavailable'`. `identity`: their `ctx.sender` hex.
     */
    users?: {
      search(
        query: string,
      ): Promise<{ username: string; avatarUrl: string | null; identity: string }[]>;
    };

    /**
     * Google Drive, Docs and Sheets in the viewer's own account: present only
     * when this tik declares the `google` provider. See `TikGoogle`.
     */
    google?: TikGoogle;

    /**
     * OpenRouter AI models on the viewer's own key: present only when this tik
     * declares the `openrouter` provider. See `TikOpenRouter`.
     */
    openrouter?: TikOpenRouter;

    /**
     * One setup flow for several providers: present when this tik declares any.
     * See `TikProviders`.
     */
    providers?: TikProviders;

    /** Subscribe to a host event. Fires on change only, never on registration. */
    on(event: 'visible' | 'hidden', handler: () => void): void;

    /** Unsubscribe a handler registered with `on`. */
    off(event: 'visible' | 'hidden', handler: () => void): void;
  }

  // Provider surfaces: on `tik` only when the tik declares the provider.

  /**
   * Google (Drive, Docs, Sheets), present ONLY when this tik declares the
   * `google` provider; absence is the feature test, as everywhere on this
   * surface.
   *
   * ## The storage model
   *
   * Everything operates inside THIS TIK'S OWN FOLDER in the viewer's Drive
   * (`Codetik/<tik title>`, created automatically on first write). Files the
   * user or other tiks created elsewhere are unreachable, and a foreign or
   * mistyped id fails EXACTLY like a missing one, so don't try to tell the
   * two apart. The data is genuinely the viewer's: they can open, edit,
   * rename or delete any of it in the Drive/Docs/Sheets apps, so read
   * defensively (a sheet may have extra columns, a doc may be hand-edited).
   *
   * Each VIEWER gets their own copies in their own Drive: this is
   * per-viewer storage that outlives the tik, not shared state (shared
   * state is the tik's own database via `tik.spacetimedb`).
   *
   * ## Ids and names
   *
   * File ids come from `open`/`list`/`writeFile` results. `open` and
   * `writeFile` are get-or-create/overwrite BY NAME within the folder, so a
   * tik finds its own files across sessions without storing an id anywhere;
   * the idiomatic start of a session is one `open` call per file it uses.
   *
   * ## The gate, and errors
   *
   * Call `await tik.google.require()` FIRST and only proceed on `true`: it
   * walks the viewer through connecting an account when needed and stays
   * pending meanwhile. Every method returns a Promise; AWAIT ALL OF THEM.
   * A call made while the tik is HIDDEN waits until it is shown, then
   * runs, so it is safe to load data on mount even from a preloaded slide.
   *
   * Failures reject with an Error carrying `.code`:
   *
   * - `not_connected`: no valid connection; call `require()` again.
   * - `denied`: not this tik's file.
   * - `rate_limited`: back off; never retry in a loop.
   * - `provider_error`: everything else; `.message` says what.
   *
   *     if (tik.google && (await tik.google.require())) {
   *       const sheet = await tik.google.sheets.open({ title: 'Scores', headers: ['when', 'score'] });
   *       await tik.google.sheets.append(sheet.id, [[new Date().toISOString(), 42]]);
   *       const { values } = await tik.google.sheets.read(sheet.id);
   *     }
   */
  interface TikGoogle {
    /**
     * The consent gate. Resolves `true` once the viewer has a Google
     * account connected and allowed for this tik; stays PENDING while they
     * finish setup; `false` if they decline. Call it early, on first
     * interaction, not at page load in a loop.
     * @param message Your one-line "why" (max 100 chars), shown to the
     * viewer in the setup prompt. Say what you'll store, e.g.
     * `"to keep your workout log in your own Drive"`.
     */
    require(message?: string): Promise<boolean>;

    /**
     * Plain files in the tik's folder: JSON/text saves, exports, anything
     * that isn't a Doc or a Sheet.
     */
    drive: {
      /**
       * The tik's own folder, `{id, name, url}`. `url` opens it in the
       * viewer's Drive; show it as an "open my data" link so the viewer
       * can see everything the tik keeps.
       */
      folder(): Promise<{ id: string; name: string; url: string | null }>;
      /**
       * Everything this tik has created, newest metadata included.
       * @param options.kind Filter: `'doc'` | `'sheet'` | `'file'` (plain
       * files). Omit for everything.
       */
      list(options?: { kind?: 'doc' | 'sheet' | 'file' }): Promise<{
        files: {
          id: string;
          name: string;
          kind: 'doc' | 'sheet' | 'file';
          modifiedTime: string | null;
          url: string | null;
        }[];
      }>;
      /**
       * Write a file into the folder. Matched BY NAME: a file with this
       * name is overwritten, otherwise it is created, so this is also
       * "save": `writeFile('save.json', JSON.stringify(state))`.
       * @param content Text (≤2MB) by default. For BINARY data (a
       * generated image), pass base64 WITHOUT any `data:` prefix and set
       * `encoding: 'base64'` (≤6MB decoded); with the right `mimeType`
       * the file previews properly in Drive.
       * @param options.mimeType Defaults to `text/plain`; use
       * `application/json` for saves, `image/png` etc. for binaries.
       */
      writeFile(
        name: string,
        content: string,
        options?: { mimeType?: string; encoding?: 'base64' },
      ): Promise<{ id: string; name: string; url: string | null }>;
      /**
       * Read a file this tik wrote, as text (≤2MB). For JSON saves,
       * `JSON.parse` the content inside try/catch, since the viewer can
       * edit the file by hand.
       */
      readFile(fileId: string): Promise<{
        content: string;
        name: string | null;
        mimeType: string | null;
      }>;
      /** Rename one of the tik's files (any kind, docs and sheets too). */
      rename(
        fileId: string,
        name: string,
      ): Promise<{ id: string; name: string; url: string | null }>;
      /**
       * Move a file to the viewer's Drive trash, recoverable by THEM for
       * 30 days, so prefer this over destroying data you can't restore.
       */
      trash(fileId: string): Promise<{ id: string }>;
      /**
       * Publish a doc or sheet TO THE WEB, readable by ANYONE with the
       * link, indexable by search engines. The viewer confirms the
       * transition in a system dialog (never remembered); re-publishing an
       * already-public file asks nothing and just returns the links. Later
       * edits stay live in the published copy. `embedUrl` is iframe-ready;
       * embedding also needs the tik's frames permission, which is
       * platform-granted.
       */
      publish(fileId: string): Promise<{ url: string; embedUrl: string }>;
      /** Take a published doc or sheet off the web. No confirm needed. */
      unpublish(fileId: string): Promise<{ published: boolean }>;
    };

    /**
     * Google Docs, spoken entirely in MARKDOWN: headings, emphasis,
     * links, lists and tables survive both directions. The genre: a tik
     * that leaves a real document behind (journal, study notes, report).
     *
     * Markdown IMAGE syntax (`![](…)`) is stripped on import; for a
     * picture in the doc, save it with `drive.writeFile(…, { encoding:
     * 'base64' })` and call `docs.insertImage`; a plain markdown LINK to
     * the file works too.
     */
    docs: {
      /**
       * Get-or-create a doc by title in the tik's folder. Returns the same
       * doc on every later call with the same title, so call this at the
       * start of a session instead of storing the id.
       */
      open(options: {
        title: string;
      }): Promise<{ id: string; name: string; url: string | null }>;
      /**
       * Replace the WHOLE document with this markdown (≤2MB). Anything the
       * viewer wrote or formatted by hand is replaced too; for a doc the
       * viewer also edits, prefer `append`.
       */
      write(fileId: string, markdown: string): Promise<{ id: string }>;
      /**
       * Add markdown to the end. Read-modify-write underneath, so exotic
       * hand-made formatting may be simplified to what markdown can carry;
       * say so in your UI if the doc is meant for hand-editing.
       */
      append(fileId: string, markdown: string): Promise<{ id: string }>;
      /**
       * Insert an image at the END of the doc, from an image file the tik
       * saved with `drive.writeFile(…, { encoding: 'base64' })`. The doc
       * stores its own copy of the image (deleting the Drive file later
       * doesn't remove it from the doc). Mechanics: the image file is
       * link-readable for the seconds Google needs to fetch it, then the
       * permission is revoked.
       */
      insertImage(
        fileId: string,
        imageFileId: string,
      ): Promise<{ id: string }>;
      /** The whole document as markdown (≤2MB export). */
      read(fileId: string): Promise<{
        markdown: string;
        name: string | null;
        modifiedTime: string | null;
      }>;
    };

    /**
     * Google Sheets, the tik's per-viewer table storage. Two genres, two
     * methods: `append` for LOGS (one row per event, nothing overwritten),
     * `write` for STATE (a range the tik keeps updating). First sheet tab
     * only; ranges are A1 notation without a tab name.
     */
    sheets: {
      /**
       * Get-or-create a spreadsheet by title in the tik's folder.
       * @param options.headers Becomes row 1, ON CREATION ONLY, never
       * reapplied, so renaming columns later means a `write` to row 1.
       */
      open(options: {
        title: string;
        headers?: (string | number | boolean)[];
      }): Promise<{ id: string; name: string; url: string | null }>;
      /**
       * Append rows after the current last row. ≤100 rows per call, ≤26
       * cells per row, cells ≤2000 chars. Values are entered as a user
       * would type them, so `'=SUM(...)'` becomes a real formula;
       * prefix with `'` if you need a literal `=`.
       */
      append(
        fileId: string,
        rows: (string | number | boolean | null)[][],
      ): Promise<{
        updatedRange: string | null;
        updatedRows: number | null;
      }>;
      /**
       * Overwrite a specific range, for state the tik maintains: a
       * running total, one row per player, a settings row. Same limits as
       * `append`; `range` like `'D1'` or `'A2:C10'`.
       */
      write(
        fileId: string,
        range: string,
        rows: (string | number | boolean | null)[][],
      ): Promise<{
        updatedRange: string | null;
        updatedRows: number | null;
      }>;
      /** Empty a range (values only; formatting survives). */
      clear(fileId: string, range: string): Promise<{
        clearedRange: string | null;
      }>;
      /**
       * Read a range (default `A1:Z1000`). `values` is rows of cells as
       * strings/numbers; ragged rows are normal (trailing empty cells are
       * omitted), and the viewer may have added columns, so read by header
       * position defensively.
       */
      read(
        fileId: string,
        options?: { range?: string },
      ): Promise<{ values: unknown[]; range: string }>;
      /**
       * Insert blank rows, shifting everything below DOWN. `at` is the
       * 1-based row the blanks take, the same numbering as `A5`. Use this
       * rather than rewriting the block below a row.
       */
      insertRows(
        fileId: string,
        options: { at: number; count?: number },
      ): Promise<{ at: number; count: number }>;
      /**
       * Delete rows, shifting everything below UP, so no gap is left, which
       * `clear` would. `at` is 1-based; `count` defaults to 1, max 100.
       */
      deleteRows(
        fileId: string,
        options: { at: number; count?: number },
      ): Promise<{ at: number; count: number }>;
      /**
       * Style a range: any of bold / italic / strikethrough, plus hex `color`
       * (text) and `background`. Only what you pass changes, so styling a
       * header bold later does not drop its fill.
       *
       *     await tik.google.sheets.format(id, 'A1:C1', { bold: true, background: '#eef2ff' });
       *     await tik.google.sheets.format(id, 'A4:C4', { strikethrough: true, color: '#9aa0a6' });
       */
      format(
        fileId: string,
        range: string,
        options: {
          bold?: boolean;
          italic?: boolean;
          strikethrough?: boolean;
          color?: string;
          background?: string;
        },
      ): Promise<{ range: string }>;
      /** Grid lines around AND between the cells of a range. */
      borders(
        fileId: string,
        range: string,
        options?: { color?: string; thick?: boolean },
      ): Promise<{ range: string }>;
      /**
       * Give a row an id that survives rows being added or removed above it,
       * including edits the viewer makes in Sheets itself. Store the id, not
       * the row number: a stored number is wrong the moment anything shifts.
       */
      tagRow(
        fileId: string,
        options: { at: number; id: string },
      ): Promise<{ at: number; id: string }>;
      /** Where a tagged row is NOW (1-based), or `at: null` if it is gone. */
      findRow(
        fileId: string,
        options: { id: string },
      ): Promise<{ id: string; at: number | null }>;
    };
  }

  /**
   * OpenRouter, when this tik DECLARES the provider, absent otherwise, so
   * presence is the feature test. `require()` runs the whole setup gate: it
   * resolves `true` once the viewer has the provider connected and allowed
   * for this tik, staying PENDING while they finish setup, and `false` if
   * they decline. Call it early (e.g. on first visible) and AWAIT it:
   * every promise on this surface must be awaited.
   *
   *     if (tik.openrouter && (await tik.openrouter.require())) {
   *       // provider calls will work now
   *     }
   */
  interface TikOpenRouter {
    /** Optional message: your one-line "why" (max 100 chars), shown in the setup prompt. */
    require(message?: string): Promise<boolean>;
  }

  /**
   * The combined provider gate, present whenever this tik declares ANY
   * provider. One call runs ONE setup flow for every listed provider:
   *
   *     if (tik.providers && (await tik.providers.require(['openrouter', 'google']))) {
   *       // all listed providers are connected and allowed
   *     }
   *
   * Same contract as the per-provider require(): stays PENDING while the
   * viewer finishes setup, `true` when everything is connected, `false` on
   * decline. Every listed id must be declared by the tik. AWAIT it.
   */
  interface TikProviders {
    /** `message`: your one-line "why" (max 100 chars), shown in the setup prompt. */
    require(
      ids: ('openrouter' | 'google')[],
      message?: string,
    ): Promise<boolean>;
  }

  const tik: TikApi;

  interface Window {
    tik: TikApi;
  }
}

export {};
