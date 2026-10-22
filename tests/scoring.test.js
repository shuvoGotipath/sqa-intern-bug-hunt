import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, matchBug, maxScore, reproducibilityScore, expectedActualScore } from '../server/evaluation/scoring.js';
import { BUGS, BUG_BY_ID } from '../server/evaluation/answerKey.js';

let seq = 0;
const report = (module, title, steps, expected, actual, severity = 'Medium', priority = 'P2', extra = {}) => ({
  id: `r${++seq}`,
  module,
  title,
  steps,
  expected,
  actual,
  severity,
  priority,
  admin_verdict: 'auto',
  ...extra,
});

/** One realistic, well-written report per planted bug, phrased the way a candidate might. */
const GOOD = {
  'REG-01': report('Registration & Login', 'Registration accepts email without domain extension', '1. Open Register\n2. Enter email "tester@mail"\n3. Fill the rest and submit', 'An error says the email address is invalid', 'The account is created with an email that has no .com', 'Medium', 'P3'),
  'REG-02': report('Registration & Login', 'Password of 7 characters accepted on sign up', '1. Go to Register\n2. Use password "Abcdef1" (7 chars)\n3. Submit', 'Error: password must be at least 8 characters', 'Account is created with a 7 character password'),
  'REG-03': report('Registration & Login', 'Confirm password ignores upper/lower case', '1. Register\n2. Password Secret123, confirm SECRET123\n3. Submit', 'Passwords do not match error is shown', 'Account is created although the two passwords differ in case'),
  'REG-04': report('Registration & Login', 'Full name with only spaces is accepted', '1. Open Register\n2. Type three spaces as name\n3. Fill other fields and submit', 'Validation error that the name is required', 'Account created, header greets "Hi, " with blank name', 'Low', 'P3'),
  'LOGIN-01': report('Registration & Login', 'Wrong password shows misleading error message', '1. Open Log in\n2. Enter demo@shopnest.test and a wrong password\n3. Click Log in', 'Message says the password is incorrect', 'Message says "No account found with this email" even though it exists', 'Low', 'P3'),
  'PRO-01': report('Profile', 'Phone number is not saved after clicking Save', '1. Log in and open Profile\n2. Change phone to +1 555 0199\n3. Click Save, reload the page', 'New phone number is still shown after reload', 'Success message appears but phone reverts to the old value', 'High', 'P2'),
  'PRO-02': report('Profile', 'Date of birth in the future is accepted', '1. Open Profile\n2. Set date of birth to 2030-01-01\n3. Save', 'Error: date of birth cannot be in the future', 'Saved successfully and Age shows -4', 'Medium', 'P3'),
  'PRO-03': report('Profile', 'Bio counter goes negative past 150 characters', '1. Open Profile\n2. Paste 160 characters into Bio\n3. Save', 'Input stops at 150 characters as the counter says', 'Counter shows -10 characters left and the bio saves', 'Low', 'P4'),
  'PRD-01': report('Product Listing & Search', 'Search is case sensitive', '1. Open Shop\n2. Search "lamp"\n3. Search "Lamp"', 'Both searches show the LED Desk Lamp', 'Lowercase search shows no results, capitalised works'),
  'PRD-02': report('Product Listing & Search', 'Sort by price low to high is in the wrong order', '1. Open Shop\n2. Choose Price: Low to High', 'Products are ordered $5, $8.50, $12 …', '$129 appears before $15.75 and $5 is near the end'),
  'PRD-03': report('Product Listing & Search', 'Product count label does not change when filtering', '1. Open Shop\n2. Choose category Wearables', 'Label says Showing 2 products', 'Label still says Showing 12 products while 2 are visible', 'Low', 'P3'),
  'PRD-04': report('Product Listing & Search', 'Out of stock headphones can be added to cart', '1. Open Studio Headphones Pro details\n2. Click Add to cart\n3. Open cart', 'Add to cart is disabled for an out of stock product', 'The product is added to the cart', 'High', 'P2'),
  'CART-01': report('Cart', 'Negative quantity accepted in cart', '1. Add an item to cart\n2. Type -2 in the quantity box\n3. Press Tab', 'Quantity must be at least 1', 'Subtotal and total become negative', 'Critical', 'P1'),
  'CART-02': report('Cart', 'Cannot set quantity to 10 although maximum is 10', '1. Add item to cart\n2. Enter 10 as quantity', 'Quantity 10 is accepted because it is the allowed maximum', 'Error "Maximum quantity per item is 10" and value resets', 'Medium', 'P3'),
  'CART-03': report('Cart', 'Coupon SAVE10 can be applied multiple times', '1. Add items\n2. Enter SAVE10 and click Apply\n3. Click Apply again 3 times', 'Second apply shows coupon already applied', 'Discount keeps increasing with each click', 'High', 'P1'),
  'CART-04': report('Cart', 'Cart badge in header not updated after removing item', '1. Add two products\n2. Open cart and click Remove on one', 'Header badge shows 1', 'Badge still shows 2 until reload', 'Low', 'P3'),
  'CART-05': report('Cart', 'Free shipping not applied at exactly $50', '1. Add 2 x Desk Organizer ($25)\n2. Open cart', 'Shipping is free because the subtotal is $50.00', 'Shipping $4.99 is charged', 'Low', 'P3'),
  'CHK-01': report('Checkout', 'Order can be placed with an empty cart', '1. Make sure cart is empty\n2. Click Proceed to checkout\n3. Fill details and Place order', 'Checkout is blocked when the cart has no items', 'Order SN-1001 created with total $0.00', 'High', 'P2'),
  'CHK-02': report('Checkout', 'Expired card accepted at checkout', '1. Go to checkout\n2. Enter expiry 01/26\n3. Place order', 'Error that the card has expired', 'Order is placed with a past expiry date', 'High', 'P2'),
  'CHK-03': report('Checkout', 'Double click on Place order creates duplicate orders', '1. Fill checkout form\n2. Double-click Place order\n3. Open Orders', 'Only one order is created', 'Two identical orders appear in order history', 'High', 'P2'),
  'UI-01': report('Responsive Layout / UI', 'Cart link missing in mobile menu', '1. Switch to Mobile width\n2. Open the hamburger menu', 'Menu contains a Cart link', 'Only Shop, Profile and Orders are shown — no way to reach the cart'),
  'UI-02': report('Responsive Layout / UI', 'Checkout form overflows on mobile', '1. Switch the preview to Mobile width\n2. Add an item and go to checkout', 'Form fits the screen', 'Page scrolls horizontally and the Place order button is cut off'),
};

describe('automatic matching', () => {
  for (const bug of BUGS) {
    test(`a good report for ${bug.id} matches ${bug.id}`, () => {
      assert.ok(GOOD[bug.id], `missing sample for ${bug.id}`);
      assert.equal(matchBug(GOOD[bug.id])?.id, bug.id);
    });
  }

  test('reports about intended behaviour do not match anything', () => {
    const fp = report('Other', 'Footer text is grey', '1. Scroll to the bottom of the page', 'Footer should be black', 'Footer is grey');
    assert.equal(matchBug(fp), null);
  });
});

describe('quality scoring', () => {
  test('reproducibility rewards clear multi-step instructions', () => {
    assert.equal(reproducibilityScore('1. Open Shop\n2. Search "lamp"\n3. Observe results'), 1);
    assert.ok(reproducibilityScore('search lamp lowercase') < 1);
    assert.equal(reproducibilityScore('broken'), 0);
  });

  test('vague or identical expected/actual earns nothing', () => {
    assert.equal(expectedActualScore('should work', "doesn't work"), 0);
    assert.equal(expectedActualScore('same text here', 'same text here'), 0);
    assert.equal(expectedActualScore('The LED Desk Lamp is shown', 'No products are shown at all'), 1);
  });

  test('a perfect set of reports scores 100%', () => {
    const ev = evaluate(Object.values(GOOD), 0);
    assert.equal(ev.bugsFound, BUGS.length);
    const imperfect = ev.reports.filter((r) => r.notes.length).map((r) => `${r.bugId}: ${r.notes.join(' ')}`);
    assert.deepEqual(imperfect, []);
    assert.equal(ev.score, 100);
    assert.equal(ev.rawPoints, maxScore());
  });

  test('vague report for a real bug earns less than a clear one', () => {
    const vague = report('Product Listing & Search', 'search case problem', 'search lamp', 'should work', "doesn't work", 'Low', 'P4');
    const good = evaluate([GOOD['PRD-01']]).reports[0].points;
    const poor = evaluate([vague]).reports[0];
    assert.equal(poor.bugId, 'PRD-01');
    assert.ok(poor.points < good / 2, `${poor.points} should be < half of ${good}`);
  });

  test('duplicates earn nothing; the best report counts', () => {
    const dup = { ...GOOD['PRD-01'], id: 'dup1', steps: 'search lamp', title: 'Search case sensitive again' };
    const ev = evaluate([dup, GOOD['PRD-01']]);
    assert.equal(ev.duplicates, 1);
    const dupResult = ev.reports.find((r) => r.reportId === 'dup1');
    assert.equal(dupResult.status, 'duplicate');
    assert.equal(dupResult.points, 0);
  });

  test('severity/priority accuracy: exact > one-off > far-off', () => {
    const base = GOOD['CART-03'];
    const exact = evaluate([base]).rawPoints;
    const near = evaluate([{ ...base, severity: 'Critical', priority: 'P2' }]).rawPoints;
    const far = evaluate([{ ...base, severity: 'Low', priority: 'P4' }]).rawPoints;
    assert.ok(exact > near && near > far);
  });

  test('false positives and hints reduce the score', () => {
    const fp = report('Other', 'Footer text is grey', '1. Scroll to the bottom', 'Footer should be black text', 'Footer text is grey in colour');
    const clean = evaluate([GOOD['PRD-01'], GOOD['CART-01']], 0);
    const withFp = evaluate([GOOD['PRD-01'], GOOD['CART-01'], fp], 0);
    const withHints = evaluate([GOOD['PRD-01'], GOOD['CART-01']], 2);
    assert.ok(withFp.rawPoints < clean.rawPoints);
    assert.equal(withFp.unmatched, 1);
    assert.ok(withHints.rawPoints < clean.rawPoints);
    assert.equal(withHints.breakdown.hintPenalty, -6);
  });

  test('admin overrides: invalid, explicit match and extra finding', () => {
    const invalid = evaluate([{ ...GOOD['PRD-01'], admin_verdict: 'invalid' }]);
    assert.equal(invalid.bugsFound, 0);
    const fp = report('Other', 'Typo on footer', '1. Scroll down\n2. Read footer text', 'Footer text is spelled correctly', 'Footer contains the word "paymnets"');
    const forced = evaluate([{ ...fp, admin_verdict: 'bug:PRD-03' }]);
    assert.deepEqual(forced.foundBugIds, ['PRD-03']);
    const extra = evaluate([{ ...fp, admin_verdict: 'extra' }]);
    assert.ok(extra.breakdown.extraFindings > 0);
    assert.equal(extra.unmatched, 0);
  });

  test('every bug has a sensible configuration', () => {
    for (const b of BUGS) {
      assert.ok(['easy', 'medium', 'hard'].includes(b.difficulty), b.id);
      assert.ok(b.match.length >= 2, `${b.id} needs at least 2 match groups`);
      assert.equal(BUG_BY_ID[b.id], b);
    }
  });
});
