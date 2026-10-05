import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindWeights, valuePerPromo } from '../src/engine.js';

test('kindWeights — משולב מתחלק לפי hybrid_weight', () => {
  assert.deepEqual(kindWeights({ promo: 2, value: 4, hybrid: 2 }, 0.5), { promo: 3, value: 5 });
  assert.deepEqual(kindWeights({ promo: 2, value: 4, hybrid: 2 }, 1), { promo: 4, value: 4 });
  assert.deepEqual(kindWeights({ promo: 2, value: 4, hybrid: 2 }, 0), { promo: 2, value: 6 });
});

test('valuePerPromo — אותה נוסחה כמו שער המנוע, עם ההגדרה של הארגון', () => {
  // (4 + 2·0.7) / (1 + 2·0.3) = 5.4 / 1.6 = 3.375
  assert.equal(valuePerPromo({ promo: 1, value: 4, hybrid: 2 }, 0.3), 3.4);
  // הנוסחה הישנה בכרטיס — (4 + 2·0.5) / 1 = 5 — הייתה שונה מהמנוע
  assert.notEqual(valuePerPromo({ promo: 1, value: 4, hybrid: 2 }, 0.5), 5);
  assert.equal(valuePerPromo({ promo: 1, value: 4, hybrid: 2 }, 0.5), 2.5);
});

test('valuePerPromo — מחרוזת מה-DB (numeric) עובדת כמו מספר', () => {
  assert.equal(valuePerPromo({ promo: 1, value: 3, hybrid: 0 }, '0.5'), 3);
});

test('valuePerPromo — null רק כשאין משקל מכירתי בכלל', () => {
  assert.equal(valuePerPromo({ promo: 0, value: 5, hybrid: 0 }, 0.5), null);
  // משולב בלבד כבר נותן משקל מכירתי
  assert.equal(valuePerPromo({ promo: 0, value: 2, hybrid: 2 }, 0.5), 3);
  assert.equal(valuePerPromo({ promo: 0, value: 2, hybrid: 2 }, 0), null);
});
