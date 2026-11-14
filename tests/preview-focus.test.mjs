// A preview that loads does not take the keyboard by itself (client/components/preview-focus.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewFocus } from '../client/components/preview-focus.js';

function setup() {
  const doc = { activeElement: null, body: { name: 'body', isConnected: true } };
  const focusable = (name) => {
    const node = { name, isConnected: true, focus() { doc.activeElement = node; } };
    return node;
  };
  const frame = focusable('frame');
  const toolbarButton = focusable('toolbar');
  const rail = focusable('rail');
  doc.activeElement = rail;
  const focus = createPreviewFocus({ frame, doc, fallback: () => toolbarButton });
  return { doc, frame, toolbarButton, rail, focus };
}

test('a preview that focuses itself on load gives the keyboard back', () => {
  const { doc, frame, rail, focus } = setup();
  focus.loading();
  frame.focus(); // the product's own input.focus() during load
  focus.loaded();
  assert.equal(doc.activeElement, rail);
});

test('the first toolbar button takes over when the remembered element is gone', () => {
  const { doc, frame, toolbarButton, rail, focus } = setup();
  focus.loading();
  rail.isConnected = false; // the rail re-rendered
  frame.focus();
  focus.loaded();
  assert.equal(doc.activeElement, toolbarButton);
});

test('the toolbar also takes over from the body and from an element that cannot take focus', () => {
  const a = setup();
  a.doc.activeElement = a.doc.body;
  a.focus.loading();
  a.frame.focus();
  a.focus.loaded();
  assert.equal(a.doc.activeElement, a.toolbarButton);

  const b = setup();
  b.rail.focus = () => {}; // hidden or disabled since
  b.focus.loading();
  b.frame.focus();
  b.focus.loaded();
  assert.equal(b.doc.activeElement, b.toolbarButton);
});

test('a preview pressed during the load keeps the keyboard', () => {
  const { doc, frame, focus } = setup();
  focus.loading();
  focus.press();
  frame.focus();
  focus.loaded();
  assert.equal(doc.activeElement, frame);
});

test('a reload nobody asked for does not blur a preview the person clicked', () => {
  const { doc, frame, focus } = setup();
  focus.loading();
  focus.loaded();
  focus.press();
  frame.focus();
  focus.loading(); // the frame still holds the keyboard
  focus.loaded();
  assert.equal(doc.activeElement, frame);
});

test('Try from the toolbar follows the rule: the earlier press no longer counts', () => {
  const { doc, frame, rail, focus } = setup();
  focus.press();
  frame.focus();
  rail.focus(); // the person moved to a studio control and reloaded from there
  focus.loading();
  frame.focus();
  focus.loaded();
  assert.equal(doc.activeElement, rail);
});

test('choosing another project drops the press even if the frame still holds the keyboard', () => {
  const { doc, frame, rail, focus } = setup();
  focus.loading();
  focus.press();
  frame.focus();
  focus.chosen();
  focus.loading();
  focus.loaded();
  assert.equal(doc.activeElement, rail);
});

test('a load that did not move the keyboard changes nothing', () => {
  const { doc, toolbarButton, focus } = setup();
  focus.loading();
  toolbarButton.focus(); // the person moved on while it loaded
  focus.loaded();
  assert.equal(doc.activeElement, toolbarButton);
});
