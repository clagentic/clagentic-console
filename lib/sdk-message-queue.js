// Async message queue for streaming input to SDK
function createMessageQueue() {
  var queue = [];
  var waitingResolvers = [];
  var ended = false;
  return {
    push: function(msg) {
      if (waitingResolvers.length > 0) {
        var resolve = waitingResolvers.shift();
        resolve({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    end: function() {
      ended = true;
      while (waitingResolvers.length > 0) {
        var resolve = waitingResolvers.shift();
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise(function(resolve) {
            waitingResolvers.push(resolve);
          });
        },
      };
    },
  };
}

module.exports = { createMessageQueue: createMessageQueue };
