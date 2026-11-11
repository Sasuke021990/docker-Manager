'use strict';

// Last 100 action events, in memory (FR-031, D-013).

const CAP = 100;

function createActivity(bus) {
  const entries = [];
  let seq = 0;
  return {
    append(entry) {
      const record = {
        id: `a${++seq}-${Date.now()}`,
        at: new Date().toISOString(),
        ...entry
      };
      entries.push(record);
      if (entries.length > CAP) entries.shift();
      if (bus) bus.publish('activity.appended', record);
      return record;
    },
    list() {
      return entries.slice().reverse(); // newest first
    },
    size: () => entries.length
  };
}

module.exports = { createActivity, CAP };
