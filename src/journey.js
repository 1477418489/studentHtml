export const MAX_STATION_NAME_LENGTH = 80;

export function emptyJourney() {
  return { stations: [], stopIds: [], currentStopId: null, completed: false };
}

// 旧名册没有 journey；已有站点数据若损坏则停止读取，避免下次保存覆盖它。
export function normalizeJourney(value) {
  if (value === undefined) return emptyJourney();
  const invalid = () => { throw new Error("invalid_journey"); };
  if (!value || !Array.isArray(value.stations) || !Array.isArray(value.stopIds)
    || typeof value.completed !== "boolean") invalid();
  const ids = new Set();
  const names = new Set();
  const stations = value.stations.map((station) => {
    if (!station || typeof station.id !== "string" || !station.id.trim()
      || typeof station.name !== "string") invalid();
    const name = station.name.trim();
    if (!name || name.length > MAX_STATION_NAME_LENGTH || ids.has(station.id) || names.has(name)) invalid();
    ids.add(station.id);
    names.add(name);
    return { id: station.id, name };
  });
  const stopIds = [...value.stopIds];
  if (new Set(stopIds).size !== stopIds.length || stopIds.some((id) => !ids.has(id))) invalid();
  const currentStopId = value.currentStopId;
  if (currentStopId !== null && !stopIds.includes(currentStopId)) invalid();
  if (value.completed && (!stopIds.length || currentStopId !== null)) invalid();
  return { stations, stopIds, currentStopId, completed: value.completed };
}

export function sameStopOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

// 改名或删掉未选站点不会改变进度；改动本趟线路则从未出发重新开始。
export function configureJourney(previous, stations, stopIds, resetProgress = false) {
  const reset = resetProgress || !sameStopOrder(previous.stopIds, stopIds);
  return normalizeJourney({
    stations,
    stopIds,
    currentStopId: reset ? null : previous.currentStopId,
    completed: reset ? false : previous.completed
  });
}

export function journeyProgress(journey) {
  const currentIndex = journey.stopIds.indexOf(journey.currentStopId);
  return {
    currentIndex,
    passedCount: journey.completed ? journey.stopIds.length : Math.max(0, currentIndex),
    nextStopId: journey.completed ? null : journey.stopIds[currentIndex + 1] ?? null
  };
}
