// Keep UIKit's tab buttons accessible while removing a labelled, inert wrapper
// introduced by the iOS 26 glass tab bar. Patch the pinned native controller at
// prebuild time so this also runs after UIKit rebuilds its views during layout.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

const MARKER = '// Union Ground: ignore inert duplicate tab labels.';
const NATIVE_FIX = `
${MARKER}
static BOOL UGContainsTabButton(UIView *view, NSString *label)
{
  for (UIView *child in view.subviews) {
    if ((child.accessibilityTraits & UIAccessibilityTraitButton) != 0 &&
        [child.accessibilityLabel isEqualToString:label]) {
      return YES;
    }
    if (UGContainsTabButton(child, label)) {
      return YES;
    }
  }
  return NO;
}

static void UGRemoveDuplicateTabLabels(UIView *view, UIView *tabBar)
{
  for (UIView *child in view.subviews) {
    UGRemoveDuplicateTabLabels(child, tabBar);
  }
  NSString *label = view.accessibilityLabel;
  if (label.length > 0 && (view.accessibilityTraits & UIAccessibilityTraitButton) == 0 &&
      UGContainsTabButton(tabBar, label)) {
    // A duplicate may wrap the button or sit beside it. Never hide descendants.
    view.isAccessibilityElement = NO;
    view.accessibilityLabel = @"";
  }
}
`;
const LAYOUT_FIX = `
- (void)viewDidLayoutSubviews
{
  [super viewDidLayoutSubviews];
  if (@available(iOS 26.0, *)) {
    // Start below the tab bar, preserving its container semantics and label.
    for (UIView *child in self.tabBar.subviews) {
      UGRemoveDuplicateTabLabels(child, self.tabBar);
    }
  }
}

`;

function repairTabAccessibility(source) {
  if (source.includes(MARKER)) {
    if (!source.includes(NATIVE_FIX) || !source.includes(LAYOUT_FIX)) {
      throw new Error('iOS tab accessibility: existing patch differs from the maintained repair.');
    }
    // Revalidate the dependency underneath our idempotent patch as well.
    repairTabAccessibility(source.replace('\n' + NATIVE_FIX, '').replace(LAYOUT_FIX, ''));
    return source;
  }
  const importsEnd = '#define RNS_MORE_NAVIGATION_CONTROLLER_AVAILABLE !TARGET_OS_TV && !TARGET_OS_VISION';
  const implementation = '@implementation RNSTabBarController';
  const update = '  [self updateTabBarA11yIfNeeded];';
  if (source.split(importsEnd).length !== 2 || source.split(implementation).length !== 2 ||
      source.split(update).length !== 2 || source.includes('- (void)viewDidLayoutSubviews')) {
    throw new Error('iOS tab accessibility: pinned native controller anchors changed.');
  }
  // The implementation has an ivar block; insert the layout override before
  // an existing method rather than splitting @implementation from its ivars.
  const anchor = '- (void)reactMountingTransactionWillMount';
  if (source.split(anchor).length !== 2) {
    throw new Error('iOS tab accessibility: layout insertion anchor changed.');
  }
  return source.replace(importsEnd, importsEnd + '\n' + NATIVE_FIX)
    .replace(anchor, LAYOUT_FIX + anchor);
}

function withIosTabAccessibility(config) {
  return withDangerousMod(config, ['ios', async (modConfig) => {
    const packagePath = require.resolve('react-native-screens/package.json', {
      paths: [modConfig.modRequest.projectRoot],
    });
    const nativeFile = path.join(path.dirname(packagePath), 'ios/tabs/host/RNSTabBarController.mm');
    const source = fs.readFileSync(nativeFile, 'utf8');
    const repaired = repairTabAccessibility(source);
    if (repaired !== source) fs.writeFileSync(nativeFile, repaired);
    return modConfig;
  }]);
}

module.exports = withIosTabAccessibility;
module.exports.repairTabAccessibility = repairTabAccessibility;
