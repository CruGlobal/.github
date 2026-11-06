import { describe, it, expect } from 'vitest'
import {
  BROKEN_LINKS_SHOWN,
  brokenLinksMessage,
  checkSiteLinks,
  decodeReferences,
  documentBase,
  htmlReferences,
  siteKeysFor
} from '../src/v2/site-links.js'

// The link check a stage-less static site's verify runs. The rules it pins
// are in the comment at the top of src/v2/site-links.js.

const values = html => htmlReferences(html).references.map(reference => reference.value)
const keys = (value, page = 'index.html', base = null) => siteKeysFor(value, documentBase(page, base))

describe('htmlReferences', () => {
  it('reads href and src in every quoting style, with the line each is on', () => {
    const html = [
      '<!doctype html>',
      '<link rel="stylesheet" href="/app.css">',
      "<script src='/app.js'></script>",
      '<img src=logo.png alt=x>',
      '<a',
      '  href = "about/" >About</a>'
    ].join('\n')
    expect(htmlReferences(html)).toEqual({
      base: null,
      references: [
        { tag: 'link', attribute: 'href', value: '/app.css', line: 2 },
        { tag: 'script', attribute: 'src', value: '/app.js', line: 3 },
        { tag: 'img', attribute: 'src', value: 'logo.png', line: 4 },
        { tag: 'a', attribute: 'href', value: 'about/', line: 6 }
      ]
    })
  })

  it('reads names in any case, and takes the first of a repeated attribute, as a browser does', () => {
    expect(values('<A HREF="/one.html" href="/two.html">x</A>')).toEqual(['/one.html'])
  })

  it('keeps a > inside a quoted value, and the slash at the end of an unquoted one', () => {
    expect(values('<a title="a > b" href="/x.html">x</a><a href=/y/>y</a>')).toEqual(['/x.html', '/y/'])
  })

  it('skips comments, doctypes, CDATA and the text of raw text elements', () => {
    const html = [
      '<!-- <a href="/commented.html"> -->',
      '<![CDATA[ <a href="/cdata.html"> ]]>',
      '<script>document.write(\'<a href="/scripted.html">\')</script>',
      '<style>/* <a href="/styled.html"> */</style>',
      '<textarea><a href="/typed.html"></textarea>',
      '<title><a href="/titled.html"></title>',
      '<SCRIPT type="module">const a = "<img src=/upper.png>"</SCRIPT >',
      '<a href="/real.html">real</a>'
    ].join('\n')
    expect(values(html)).toEqual(['/real.html'])
  })

  it('reads the src of a raw text element itself', () => {
    expect(values('<script src="/a.js"></script><iframe src="/frame.html">fallback</iframe>')).toEqual(['/a.js', '/frame.html'])
  })

  it('reads only href and src: not srcset, data-src, xlink:href or a valueless attribute', () => {
    expect(values('<img srcset="/a.png 2x" data-src="/b.png" src><svg><use xlink:href="/c.svg#i"/></svg>')).toEqual([])
  })

  it('takes the first <base href>, and does not count it as a link', () => {
    expect(htmlReferences('<base href="/docs/"><base href="/other/"><a href="x.html">x</a>')).toEqual({
      base: '/docs/',
      references: [{ tag: 'a', attribute: 'href', value: 'x.html', line: 1 }]
    })
  })

  it('decodes character references in a value', () => {
    expect(values('<a href="/a&amp;b.html"><a href="&#47;c&#x2F;d.html"><a href="/e&nbsp;f.html">')).toEqual([
      '/a&b.html', '/c/d.html', '/e f.html'
    ])
  })

  it('stops cleanly at a page that ends inside a tag, a comment or a script', () => {
    expect(values('<a href="/x.html">x</a><a href="/y.html"')).toEqual(['/x.html', '/y.html'])
    expect(values('<a href="/x.html"><!-- never closed <a href="/y.html">')).toEqual(['/x.html'])
    expect(values('<a href="/x.html"><script><a href="/y.html">')).toEqual(['/x.html'])
  })

  it('reads a < in text as text', () => {
    expect(values('<p>1 < 2 and 3 <4</p><a href="/x.html">x</a>')).toEqual(['/x.html'])
  })
})

describe('decodeReferences', () => {
  it('decodes numeric references with or without a semicolon, and named ones only with it', () => {
    expect(decodeReferences('&#65;&#x42;&#67 &amp &amp;')).toBe('ABC &amp &')
  })

  it('leaves a named reference it does not know as it is', () => {
    expect(decodeReferences('/a&copy;b')).toBe('/a&copy;b')
  })

  it('turns a code point that is not a character into U+FFFD', () => {
    expect(decodeReferences('&#0;&#xD800;&#x110000;')).toBe('���')
  })
})

describe('siteKeysFor', () => {
  it.each([
    'https://example.org/x.html',
    'http://example.org/',
    'mailto:someone@example.org',
    'tel:+10000000000',
    'data:image/png;base64,AAAA',
    'javascript:void(0)',
    '//cdn.example.org/lib.js',
    '\\\\cdn.example.org\\lib.js',
    '#top',
    '',
    '   ',
    '{{ page.url }}',
    '/docs/{{version}}/'
  ])('does not check %j', (value) => {
    expect(keys(value)).toBeNull()
  })

  it.each([
    ['/', ['index.html']],
    ['/x/', ['x/index.html']],
    ['/x', ['x', 'x/index.html']],
    ['/x.css', ['x.css']],
    ['/x.css?v=3#top', ['x.css']],
    ['/x/?tab=2', ['x/index.html']],
    ['/v1.2', ['v1.2']],
    ['/About/', ['About/index.html']],
    ['/my%20file.pdf', ['my file.pdf']],
    ['/caf%C3%A9.html', ['café.html']],
    ['/100%zz.html', ['100%zz.html']],
    ['  /x.css\n', ['x.css']],
    ['/x\n.css', ['x.css']],
    ['\\x.css', ['x.css']]
  ])('reads %j from the root page as %j', (value, expected) => {
    expect(keys(value)).toEqual(expected)
  })

  it.each([
    ['img.png', ['docs/guide/img.png']],
    ['./img.png', ['docs/guide/img.png']],
    ['../', ['docs/index.html']],
    ['../setup/', ['docs/setup/index.html']],
    ['../../../../x.css', ['x.css']],
    ['?page=2', ['docs/guide/index.html']],
    ['', null]
  ])('resolves %j from a nested page as a browser would', (value, expected) => {
    expect(keys(value, 'docs/guide/index.html')).toEqual(expected)
  })

  it('resolves against a page whose own name needs encoding', () => {
    expect(keys('img.png', 'my docs/a#b.html')).toEqual(['my docs/img.png'])
  })

  it('resolves relative links against a local <base href>', () => {
    expect(keys('x.css', 'a/b.html', '/docs/')).toEqual(['docs/x.css'])
    expect(keys('/y.css', 'a/b.html', '/docs/')).toEqual(['y.css'])
  })

  it('treats every link as pointing elsewhere under a <base href> on another host', () => {
    expect(keys('x.css', 'a/b.html', 'https://cdn.example.org/')).toBeNull()
    expect(keys('/y.css', 'a/b.html', 'https://cdn.example.org/')).toBeNull()
  })

  it('ignores an empty <base href>', () => {
    expect(keys('x.css', 'a/b.html', '')).toEqual(['a/x.css'])
  })
})

describe('checkSiteLinks', () => {
  const page = (key, html) => ({ key, contents: Buffer.from(html) })
  const served = new Set(['index.html', 'about/index.html', 'app.css', 'logo.png', 'guide'])

  it('counts the local links, and resolves each to the file that answers it', () => {
    const result = checkSiteLinks({
      pages: [
        page('index.html', '<link href="/app.css"><a href="https://example.org/">x</a><a href="about/">a</a><a href="#top">t</a>'),
        page('about/index.html', '<img src="../logo.png"><a href="/about">self</a><a href="/guide">g</a>')
      ],
      served
    })
    expect(result).toEqual({
      pages: 2,
      links: 5,
      broken: [],
      targets: new Set(['app.css', 'about/index.html', 'logo.png', 'guide'])
    })
  })

  it('reports each broken link with its page, line, value and the files that would have answered it', () => {
    const result = checkSiteLinks({
      pages: [page('about/index.html', '<p>\n<a href="../missing/">m</a>\n<img src="/img/none.png"></p>')],
      served
    })
    expect(result.broken).toEqual([
      { page: 'about/index.html', line: 2, tag: 'a', attribute: 'href', value: '../missing/', wanted: ['missing/index.html'] },
      { page: 'about/index.html', line: 3, tag: 'img', attribute: 'src', value: '/img/none.png', wanted: ['img/none.png'] }
    ])
    expect(result.links).toBe(2)
  })

  it('compares names as S3 does, case and all', () => {
    const result = checkSiteLinks({ pages: [page('index.html', '<img src="/Logo.png">')], served })
    expect(result.broken.map(link => link.wanted)).toEqual([['Logo.png']])
  })
})

describe('brokenLinksMessage', () => {
  const link = (page, line, value, key) => ({ page, line, tag: 'a', attribute: 'href', value, wanted: [key] })

  it('names each missing file once, with how many links ask for it and the first that does', () => {
    const broken = [
      link('index.html', 4, '/gone/', 'gone/index.html'),
      link('about/index.html', 4, '/gone/', 'gone/index.html'),
      link('about/index.html', 9, 'pic.png', 'about/pic.png')
    ]
    expect(brokenLinksMessage({ broken, links: 40, pages: 2 })).toBe(
      '3 of the 40 local links in the site\'s 2 HTML pages point at files that are not in the site, so those links ' +
      'would be broken once it is live. Missing: gone/index.html (2 links, first index.html line 4: href="/gone/"); ' +
      'about/pic.png (1 link, first about/index.html line 9: href="pic.png")'
    )
  })

  it(`names at most ${BROKEN_LINKS_SHOWN} files, and counts the rest`, () => {
    const broken = Array.from({ length: BROKEN_LINKS_SHOWN + 3 }, (_, i) => link('index.html', i + 1, `/p${i}.html`, `p${i}.html`))
    const message = brokenLinksMessage({ broken, links: 13, pages: 1 })
    expect(message).toContain(`p${BROKEN_LINKS_SHOWN - 1}.html`)
    expect(message).not.toContain(`p${BROKEN_LINKS_SHOWN}.html`)
    expect(message).toMatch(/, and 3 more files$/)
  })

  it('keeps a name from the image on one line in the message', () => {
    const message = brokenLinksMessage({ broken: [link('index.html', 1, '/a\n::warning::x', 'a\n::warning::x')], links: 1, pages: 1 })
    expect(message).not.toContain('\n')
  })
})
