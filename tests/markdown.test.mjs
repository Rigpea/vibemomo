// List items wrapped in the source stay one item (client/components/markdown.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdownToHtml as md } from '../client/components/markdown.js';

const count = (html, tag) => (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;

test('a wrapped item stays one li, with inline formatting on the continuation', () => {
  const html = md('1. **Compare** it and keep the\n   one you **prefer** as a version');
  assert.equal(count(html, 'li'), 1);
  assert.equal(count(html, 'p'), 0);
  assert.match(html, /keep the one you <strong>prefer<\/strong> as a version/);
});

test('two items stay two li', () => {
  const html = md('- first\n  wrapped\n- second');
  assert.equal(count(html, 'li'), 2);
  assert.equal(count(html, 'ul'), 1);
});

test('numbering keeps going after a wrapped item', () => {
  const html = md('1. a\nb\n2. c');
  assert.equal(count(html, 'ol'), 1);
  assert.equal(count(html, 'li'), 2);
});

test('a paragraph after a blank line closes the list', () => {
  const html = md('- item\n\nparagraph');
  assert.match(html, /<\/ul>\n<p>paragraph<\/p>/);
});

test('a heading closes the list', () => {
  const html = md('- item\n# Title\nafter');
  assert.match(html, /<\/ul>\n<h3>Title<\/h3>\n<p>after<\/p>/);
});

test('a blockquote, a fence and a table row are not continuations', () => {
  assert.match(md('- item\n> quote'), /<\/ul>\n<blockquote>quote/);
  assert.match(md('- item\n```\ncode\n```'), /<\/ul>\n<pre>/);
  assert.match(md('- item\n| a |\n| --- |\n| b |'), /<\/ul>\n<table>/);
  assert.match(md('- item\n| lone row |'), /<\/ul>\n<p>/);
});

test('the guide has no paragraph split off a list item and no stray bold marker', () => {
  const html = md(readFileSync(new URL('../docs/GUIDE.md', import.meta.url), 'utf8'));
  assert.ok(!html.includes('<p>one you prefer as a version'));
  assert.match(html, /and <strong>keep<\/strong> the one you prefer as a version/);
  assert.ok(!html.replace(/<code>[\s\S]*?<\/code>/g, '').includes('**'));
});
