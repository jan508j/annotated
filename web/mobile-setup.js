// Phone setup stays informational; sharing always opens the article editor for review.
export function mobileSetup(el) {
  const writeUrl = new URL('/write', location.origin).href;
  return el('div', { class: 'mobile-setup' },
    el('section', { class: 'mobile-setup-section' },
      el('h2', {}, 'Android'),
      el('p', {}, 'In Chrome, open Annotated, choose Add to Home screen or Install app from the browser menu, then confirm. Open an article in any app, tap Share, and choose Annotated. Review its source and your take in the editor before publishing.'),
      el('p', { class: 'muted' }, 'The share option appears after installation when Android and the sharing app offer a link or text. You need a connection to use Annotated.')
    ),
    el('section', { class: 'mobile-setup-section' },
      el('h2', {}, 'iPhone'),
      el('p', {}, 'In Safari, open Annotated, tap Share, then Add to Home Screen. To bring in an article, copy its link and paste it into the article editor.'),
      el('details', {},
        el('summary', {}, 'Optional Safari Share Sheet Shortcut'),
        el('p', {}, 'You can build a personal Shortcut to pass a Safari page link to the same editor. In Shortcuts, create a shortcut named “Annotate article”. In its Details, enable Show in Share Sheet and limit Receive to Safari webpages and URLs.'),
        el('ol', {},
          el('li', {}, 'Add Get URLs from Input, using Shortcut Input.'),
          el('li', {}, 'Add Get Item from List, choose First Item, then add URL Encode using that item.'),
          el('li', {}, 'Add Text. Enter the address below, followed by the encoded URL as a Shortcuts variable.'),
          el('li', {}, 'Add Open URLs, using that Text result. From a Safari page, tap Share and choose Annotate article.')
        ),
        el('code', {}, `${writeUrl}#url=`),
        el('p', { class: 'muted' }, 'Check the source link in the editor. The Shortcut carries the shared page URL. Its title fills in when available; paste your selected passage in the editor. Other apps may pass different content or omit its original page link.')
      )
    ),
    el('p', {}, el('a', { href: '/write' }, 'Open article editor'))
  );
}
