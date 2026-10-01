import test from 'node:test';
import assert from 'node:assert/strict';
import {stressPath} from '../web/stress-path.mjs';
test('random navigation is repeatable, seeded, and increases difficulty',()=>{
  for(let round=1;round<=3;round++){
    const path=stressPath(round);
    assert.deepEqual(path,stressPath(round));
    assert.notDeepEqual(path,stressPath(round,42));
    assert.equal(path.length,12+round*4);
    assert.equal(Math.max(...path.map(x=>x.zoom)),[20000,200000,2000000][round-1]);
    for(const step of path){
      assert.ok(step.zoom>=400 && Number.isFinite(step.zoom));
      assert.ok(Math.abs(step.panX)<=.5 && Math.abs(step.panY)<=.5);
    }
  }
  assert.throws(()=>stressPath(4));
});
