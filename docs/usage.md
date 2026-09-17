# Using the app

[← Back to README](../README.md)

<a name="usage"></a>

<img src="readme/banner-usage.svg" alt="Using the app" width="100%">

<br>

| Action | How |
| --- | --- |
| Send a message | Type and press `Enter` (`Shift+Enter` for a newline) |
| Switch model | Click the model pill in the composer, or open the **Models** tab |
| Attach a file | Paperclip icon — a picture, a PDF/DOCX, or any text file |
| Generate an image | Just describe it — <i>"draw a cat on a skateboard"</i>. **Session → Image** forces a drawing when the wording could go both ways |
| View / download an image | Click any generated image to zoom in, with a download link |
| Copy a reply | Copy icon under any assistant message |
| Retry a reply | Retry icon under any assistant message — resends the same prompt (or regenerates the image) |
| Start a new chat | The **+** in the sidebar, or **New chat** in the drawer — the previous chat is kept |
| Reopen an old chat | Click it in the sidebar |
| Delete one chat | The **×** on its sidebar row |
| Hide the sidebar | The ☰ button at the left of the chat bar |
| Show a model's thinking | Click the **Reasoning** strip above a reply (reasoning-capable models only) |
| Connect GitHub | **Settings** tab → **Connect GitHub** → load or commit a file in any of your public repos |
| Ask the model to use GitHub | Once connected, just say it in chat — *"read my README and fix the typos"*. Each repo action shows in the transcript, and commits ask first. |
| Set reasoning effort | The picker beside the model pill, on models that support it |
| Jump to anything | `Ctrl+P`, or **Command palette** in the drawer — type a model name or an action (a phone has no Ctrl+P, so the drawer carries it too) |
| Find a setting | The section chips across the top of **Settings** — Model, Chat, Workspace, Skills, Account, GitHub, Server |
| Save the chat as a PDF | **Save chat as PDF** in the drawer — prints through your browser, so on a phone it lands in the share sheet |
| Sign in / out | Account icon, top right, or the **Settings** tab |

**An attachment says what it costs before it is sent.** A pasted file is the one thing in a prompt that nothing trims: the history behind it is budgeted to 24k tokens, and the attachment arrives whole — so the chip carries the estimate (`~1.2k tokens`), and one that alone outweighs that entire history is tinted with the reason on hover rather than silently sent. It is the same estimate the history budget is spent in — four characters to a token — which is what makes the two numbers readable against each other, and it is shown for text only: a picture is bytes no character count can speak for.

**A drawing is read back against the request, not against its prompt.** The image model is given a rewrite of what the user said, and the picture is judged — by the person who asked — against what they said: two different things, and nothing compared them. A drawing that met its prompt but missed the request looked exactly like a good one, and the only signal was the user noticing. Now one short question goes out with the picture, the request and the prompt — *does the picture show what the request asked for?* — and the answer is one line under the picture: `Checked: this looks like what you asked for.` or `Checked: the sign reads HLLO, not HELLO` with a **Fix it** beside it. The reviewer is the cheapest model the service lists that can actually see, ranked the way a tool-reading step is (free, then price, then the small model of a family; a model whose price is unknown comes last rather than never), so a picture is never reviewed by the flagship the conversation happens to be on. Best effort in every direction, and quiet in every failure: nothing that can see, a refusal, or a reply that is not one of the two verdicts leaves no note rather than a guess, and a miss is never met with an automatic redraw — re-spending the user's key on their behalf is not this feature's call. What a difference *does* come with is a **Fix it** button on that same line: it redraws with the difference folded into the prompt that drew the picture (`imageCheckFixPrompt`, the difference verbatim rather than paraphrased, so a retry cannot lose the one fact it exists for), through whichever runner produced it — a drawing redraws, an edit re-edits the same source, a brushed edit re-edits it with the same mask — and the note it lands on is checked against the same request. The tap is the consent: nothing renders on its own, the button is dead while its render runs so a double tap cannot bill twice, and it comes back afterwards, because a fix that missed too is a fair reason to try again. Variations are not checked, because they are alternatives to a picture that already was.

**A file attaches as what it is, not as what it is called.** The gate used to be a list of nine extensions, and the same list filtered the file dialog — so `.py`, `.html`, `.css`, `.env`, `.toml`, `Makefile` and `Dockerfile` could not be selected at all, and a `.txt` holding a zipped archive was accepted and arrived in the prompt as mojibake. A picture is now decided by its MIME type (which the send path needs anyway to build a `data:` URL), a PDF or DOCX by its extension (the parser is what has to match the format), and everything else is text if the bytes decode as text — a BOM is handled, and a NUL byte or a decoder that gave up is what refuses it. The menu item only filters the dialog now: it never decides, so a PDF opened from **Files** is read and a picture opened from **Files** is attached as a picture, instead of being refused for arriving through the wrong door. The refusal names the fix (`That is not a text file — attach it as an Image or a Document`), and the decisions live in one place, `attachment-helpers.js`, rather than in a copy beside the page.

<br>

### 🎨 Appearance

The palette is a near-neutral grey ladder rather than white-on-black: the chrome (the chat rail, the top bar, the status bar) sits one step **darker** than the conversation, and the composer and the user's bubble sit one step **above** it — `#171717` / `#212121` / `#303030` in dark, `#f9f9f9` / `#ffffff` / `#f4f4f4` in light. Nothing is pure black in dark mode and nothing is pure white in light mode, which is what stops a long transcript from reading as a headlamp, and the composer is lifted off the transcript rather than sharing its grey.

The header's sun/moon button opens a picker with **System / Light / Dark** plus the three theme packs (Tokyo Night, Gruvbox, Green). It names the three the way ChatGPT does instead of cycling, because a cycle is the wrong shape for five: reaching Gruvbox from Tokyo Night meant passing through every other theme on the way. System follows the OS and keeps following it while the tab is open. The choice is stored as `puterChatTheme` in your browser, and the browser's own chrome colour (`<meta name="theme-color">`) follows it, so the status bar is not a black frame around a grey app.

**The toggle is on every screen size.** It used to be the first control dropped below 380px, on the reasoning that Ctrl+P still reaches it — which is no reasoning at all on a phone, where the appearance of the app is the one setting you cannot get to any other way. On a phone the picker opens as a sheet at the bottom of the screen; on a desktop it is a dropdown anchored under the button, right-aligned and pulled back inside the viewport. `npm run smoke` now asserts, at 360, 390, 844×390 and 1440 wide, that the toggle is visible, on screen, that the picker opens onto the viewport with all six rows usable, and that every icon button in the header is the same size at that width.

### 📱 On a phone

The composer's control row is where a phone runs out of width. It holds five things — the model, the provider, the effort, the mode, and the Session chip — which want 383px at their desktop size, and a 390px screen gives the row 350px. It used to overflow by that difference into a horizontal scroller nothing signalled: at 360px the mode chip sat *entirely* past the right edge, with not even a sliver poking out to suggest it was there.

The cause was a cascade bug rather than a missing rule. Three clamps existed — 84px at 640, 68px at 380, 92px in landscape — and **none of them ever applied**: they were written as `.model-trigger span#modelLabel` while the desktop rule was `.composer-controls .model-trigger #modelLabel`, and one id with two classes beats one id with one class and an element. A media query adds no specificity of its own, so every phone rendered the desktop widths. Nothing caught it: eslint does not read CSS, the unit tests do not render, and the smoke test only checked that the controls existed.

**The row is now one line, always, with attach at the head of it.** Reading left to right: attach, the model, the provider, the effort, the session chip, the mode. Attach is the control every message needs, so it sits at the left edge where a thumb already is, next to the model picker. It used to be a group of its own on a line of its own — which did keep it from being pushed off the edge, and spent 44px of a phone's height on one button with most of the row empty beside it. The composer drops from **162px to 112px**, and the transcript gets all fifty back.

What holds it to one line is the model name, which gives up exactly the width the row is short by. It is the right control to squeeze because it is the only one that degrades gracefully: it already ellipsises, and the full list is one tap away in its own dropdown. A chip reading "Cha…" would not. So a long provider name like `Antigravity` costs the model name some characters rather than costing a control its place.

Three details make that work, and each was a bug on the way:

- **The flex item is the wrapper, not the button.** The model picker sits inside an unclassed `position: relative` div that hosts its dropdown, so a rule aimed at `.model-trigger` read correctly and did nothing — the button is not a child of the row. It has a name now.
- **`flex-basis: 0`, not shrink.** Letting the controls shrink to fit put the pressure where content was widest, which collapsed the provider select to 10px while the model button overflowed its group. Starting the model at zero and letting it grow into what the fixed controls have not used is deterministic: the row is exactly full at every width.
- **Wrapping had to go.** A wrapping flex line does not shrink to stay one line — it wraps and leaves the items at their natural width. The two are alternatives, not a belt and braces.

Attach draws at 34×44 rather than 44×44: the row needs the width back, but a 34px square beside 44px chips reads as a control that did not line up, so only the width gives. Its finger target stays a full 44px through the same `::after` box the header's icon buttons use, and `npm run smoke` asserts that — a shrunken glyph with a shrunken target would be the wrong trade. Hiding a control was never an option: the provider picker is the only way to change service, since the model dropdown lists models alone.

**Landscape gets its second row back as height.** The shared phone layout puts the attach button on its own line so it cannot be pushed off the edge, which is right at 360px. In landscape the problem is the opposite one: the row needs 421px and has 808px, so the split bought nothing and cost 44px of a 390px viewport. The transcript grows from 167px to 211px — about a quarter more of the conversation — and the split is kept below 641px wide, where the original reasoning still holds.

One more width came free along the way: the model button was carrying the **iOS zoom guard**, the `font-size: 16px` that stops iOS zooming the viewport when a field is focused. That guard is for fields — `input`, `select`, `textarea` — and the model picker is a `<button>`, which iOS never zooms for. It did nothing there except make the widest control in the row a third wider than it needed to be, on every phone. Its dropdown holds a real search input, and that still has it.

Two checks now make this class of bug hard to reintroduce. `npm test` walks the stylesheet, scores specificity, and fails when a declaration inside a `@media` is beaten by one outside it — ignoring rivals that need a state, since `.chat-shell.history-hidden .history-sidebar` only applies while the sidebar is closed and cannot be said to win. And `npm run smoke` measures every control in the row at all five viewports rather than asking whether it exists: that it is on screen, that attach leads, that the row is one line and cannot overflow, and that nothing has collapsed. It caught the 390px case immediately, which the existence check had been passing for months.
