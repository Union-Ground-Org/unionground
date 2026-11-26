import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile(
  'MemberSupportScreen.tsx',
  readFileSync(new URL('./MemberSupportScreen.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function attribute(element: ts.JsxOpeningElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === name,
  );
}

describe('Worker Support radio grouping', () => {
  it('gives every radio a group while retaining its individual state and activation', () => {
    const radios: ts.JsxElement[] = [];
    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node)) {
        const role = attribute(node.openingElement, 'accessibilityRole')?.initializer;
        if (role && ts.isStringLiteral(role) && role.text === 'radio') radios.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(radios.length).toBeGreaterThan(0);
    const spokenGroups = new Set<string>();

    for (const radio of radios) {
      let parent: ts.Node | undefined = radio.parent;
      while (parent && !ts.isJsxElement(parent)) parent = parent.parent;
      expect(parent, radio.openingElement.getText(source)).toBeDefined();
      if (!parent || !ts.isJsxElement(parent)) throw new Error('Radio has no parent element');
      const groupRole = attribute(parent.openingElement, 'accessibilityRole')?.initializer;
      expect(groupRole && ts.isStringLiteral(groupRole) ? groupRole.text : undefined,
        parent.openingElement.getText(source)).toBe('radiogroup');

      const state = attribute(radio.openingElement, 'accessibilityState')?.initializer;
      expect(state?.getText(source)).toMatch(/\bselected\s*:/);
      expect(attribute(radio.openingElement, 'onPress')?.initializer).toBeDefined();
      const spokenLabel = attribute(radio.openingElement, 'accessibilityLabel')?.initializer;
      expect(spokenLabel && ts.isJsxExpression(spokenLabel) && spokenLabel.expression
        && ts.isCallExpression(spokenLabel.expression), 'Every choice needs spoken group context').toBeTruthy();
      if (!spokenLabel || !ts.isJsxExpression(spokenLabel) || !spokenLabel.expression
        || !ts.isCallExpression(spokenLabel.expression)) throw new Error('Missing spoken label');
      const group = spokenLabel.expression.arguments[0];
      const groupName = group && ts.isCallExpression(group) && group.expression.getText(source) === 't'
        ? group.arguments[0]
        : group;
      expect(groupName && ts.isStringLiteral(groupName) && groupName.text.trim().length > 0).toBe(true);
      if (groupName && ts.isStringLiteral(groupName)) spokenGroups.add(groupName.text);
      // Grouping must leave the child radios accessible as separate choices.
      expect(attribute(parent.openingElement, 'accessible')).toBeUndefined();
    }
    expect([...spokenGroups]).toEqual([
      'Emergency scenario', 'Accommodation type', 'Worker for HR contact', 'HR contact channel',
      'HR contact disposition', 'Onboarding worker', 'Mentorship mentor', 'Mentorship mentee',
      'Handoff worker', 'Receiving committee member', 'Handoff status',
    ]);
  });
});
