// Offline algorithm proof with minimal Objective-C test doubles; not UIKit or device evidence.
#include <objc/Object.h>
#include <objc/runtime.h>
#include <assert.h>
#include <string.h>
#include <stdio.h>
typedef unsigned long NSUInteger;
const NSUInteger UIAccessibilityTraitButton = 1;
const NSUInteger UIAccessibilityTraitSelected = 2;
@interface NSString : Object {
@public const char *bytes; unsigned int size;
}
- (NSUInteger)length;
- (BOOL)isEqualToString:(NSString *)other;
@end
@implementation NSString
- (NSUInteger)length { return size; }
- (BOOL)isEqualToString:(NSString *)other { return other && strcmp(bytes, other->bytes) == 0; }
@end
struct NSFastEnumerationState { unsigned long state; id *itemsPtr; unsigned long *mutationsPtr; unsigned long extra[5]; };
@interface NSArray : Object {
@public id entries[8]; NSUInteger count; unsigned long mutations;
}
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)len;
@end
@implementation NSArray
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)len {
  if (state->state) return 0;
  state->state = 1; state->itemsPtr = entries; state->mutationsPtr = &mutations; return count;
}
@end
@interface UIView : Object {
@public NSArray *children; NSString *label; NSUInteger traits; BOOL accessible;
}
- (NSArray *)subviews;
- (NSString *)accessibilityLabel;
- (void)setAccessibilityLabel:(NSString *)value;
- (NSUInteger)accessibilityTraits;
- (void)setIsAccessibilityElement:(BOOL)value;
@end
@implementation UIView
- (NSArray *)subviews { return children; }
- (NSString *)accessibilityLabel { return label; }
- (void)setAccessibilityLabel:(NSString *)value { label = value; }
- (NSUInteger)accessibilityTraits { return traits; }
- (void)setIsAccessibilityElement:(BOOL)value { accessible = value; }
@end
static UIView *view(NSString *label, NSUInteger traits = 0) {
  UIView *v = (UIView *)class_createInstance(objc_getClass("UIView"), 0);
  v->children = (NSArray *)class_createInstance(objc_getClass("NSArray"), 0);
  v->label = label; v->traits = traits; v->accessible = YES; return v;
}
static void add(UIView *parent, UIView *child) { parent->children->entries[parent->children->count++] = child; }

// __UNION_GROUND_NATIVE_FIX__
int main() {
  const char *names[] = {"Home, 1 of 4", "Messages, 2 of 4", "Pulse, 3 of 4", "Work, 4 of 4"};
  for (int selected = 0; selected < 4; selected++) {
    NSString *labels[4]; UIView *buttons[4];
    for (int i=0;i<4;i++) {
      labels[i]=(NSString *)class_createInstance(objc_getClass("NSString"), 0);
      labels[i]->bytes=names[i]; labels[i]->size=strlen(names[i]);
      buttons[i]=view(labels[i], UIAccessibilityTraitButton | (selected==i ? UIAccessibilityTraitSelected : 0));
    }
    UIView *wrapper=view(labels[selected]);
    UIView *nested=view((NSString *)0);
    add(wrapper,nested);
    for(int i=0;i<4;i++) add(nested,buttons[i]);
    UIView *sibling=view(labels[selected]); add(wrapper,sibling);
    UGRemoveDuplicateTabLabels(wrapper, wrapper);
    assert(!sibling->accessible && sibling->label.length==0);
    assert(!wrapper->accessible && wrapper->label.length==0);
    for(int i=0;i<4;i++) {
      assert(buttons[i]->accessible && buttons[i]->label==labels[i]);
      assert(buttons[i]->traits==(UIAccessibilityTraitButton | (selected==i ? UIAccessibilityTraitSelected : 0)));
    }
    UGRemoveDuplicateTabLabels(wrapper, wrapper);
    UIView *different=view(@"Different group"); add(different, buttons[0]);
    UGRemoveDuplicateTabLabels(different, different); assert(different->accessible && different->label.length>0);
    UIView *leaf=view(labels[selected]); UGRemoveDuplicateTabLabels(leaf, leaf); assert(leaf->accessible);
  }
  puts("PASS: native repair algorithm, four selected states, nested wrappers, unchanged button labels/traits, different groups, leaves, idempotence. This uses test doubles, not UIKit/device evidence.");
}
