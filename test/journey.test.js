import assert from "node:assert/strict";
import test from "node:test";
import { configureJourney, emptyJourney, journeyProgress, normalizeJourney } from "../src/journey.js";

const fixture = () => ({
  stations: [{ id: "a", name: "学校" }, { id: "b", name: "幸福里东门" }, { id: "c", name: "文化路口" }],
  stopIds: ["a", "b"], currentStopId: "b", completed: false
});

test("旧名册兼容空站点，十站进度可随 JSON 往返保存", () => {
  assert.deepEqual(normalizeJourney(undefined), emptyJourney());
  const stations = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, name: `第${index + 1}站` }));
  const journey = { stations, stopIds: stations.map(({ id }) => id), currentStopId: "s4", completed: false };
  assert.deepEqual(normalizeJourney(JSON.parse(JSON.stringify(journey))), journey);
  assert.deepEqual(journeyProgress(journey), { currentIndex: 4, passedCount: 4, nextStopId: "s5" });
  assert.deepEqual(journeyProgress({ ...journey, currentStopId: "s9" }), { currentIndex: 9, passedCount: 9, nextStopId: null });
  assert.deepEqual(journeyProgress({ ...journey, currentStopId: null, completed: true }), { currentIndex: -1, passedCount: 10, nextStopId: null });
});

test("改名和删除未选站点保留进度，顺序或站点变化重置进度", () => {
  const previous = fixture();
  const renamed = previous.stations.slice(0, 2).map((station) => ({ ...station, name: `${station.name}新站` }));
  assert.equal(configureJourney(previous, renamed, previous.stopIds).currentStopId, "b");
  for (const stopIds of [["b", "a"], ["a"], ["a", "b", "c"], []]) {
    const updated = configureJourney(previous, previous.stations, stopIds);
    assert.deepEqual(updated.stopIds, stopIds);
    assert.equal(updated.currentStopId, null);
    assert.equal(updated.completed, false);
  }
  assert.equal(configureJourney(previous, previous.stations, previous.stopIds, true).currentStopId, null);
  assert.equal(previous.currentStopId, "b");
});

test("结束后可保留线路重新开始，空线路和单站进度正确", () => {
  const previous = { ...fixture(), currentStopId: null, completed: true };
  assert.equal(configureJourney(previous, previous.stations, previous.stopIds).completed, true);
  const restarted = configureJourney(previous, previous.stations, previous.stopIds, true);
  assert.deepEqual(journeyProgress(restarted), { currentIndex: -1, passedCount: 0, nextStopId: "a" });
  assert.deepEqual(journeyProgress(emptyJourney()), { currentIndex: -1, passedCount: 0, nextStopId: null });
  const single = { ...fixture(), stopIds: ["b"] };
  assert.deepEqual(journeyProgress(single), { currentIndex: 0, passedCount: 0, nextStopId: null });
});

test("拒绝重复、悬空引用和不一致进度，站名去除首尾空格并保留特殊字符", () => {
  const previous = fixture();
  for (const invalid of [null, {}, { ...previous, stations: [previous.stations[0], previous.stations[0]] },
    { ...previous, stations: previous.stations.map((station) => ({ ...station, name: "同名" })) },
    { ...previous, stations: [{ id: "a", name: " " }] }, { ...previous, stopIds: ["a", "a"] },
    { ...previous, stopIds: ["missing"] }, { ...previous, currentStopId: "c" },
    { ...previous, completed: true }, { ...previous, stopIds: [], currentStopId: null, completed: true },
    { ...previous, stations: [{ id: "a", name: "站".repeat(81) }] }]) {
    assert.throws(() => normalizeJourney(invalid), /invalid_journey/);
  }
  const special = normalizeJourney({ stations: [{ id: "x", name: '  幸福里 <东门> & "A区"  ' }], stopIds: ["x"], currentStopId: null, completed: false });
  assert.equal(special.stations[0].name, '幸福里 <东门> & "A区"');
});
