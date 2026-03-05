class Queue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.active = 0;
    this.pending = 0;
    this._queue = [];
  }

  enqueue(key, fn) {
    return new Promise((resolve, reject) => {
      this.pending++;
      this._queue.push({ key, fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this._queue.length > 0) {
      const job = this._queue.shift();
      this.pending--;
      this.active++;

      job.fn()
        .then((result) => {
          this.active--;
          job.resolve(result);
          this._drain();
        })
        .catch((err) => {
          this.active--;
          job.reject(err);
          this._drain();
        });
    }
  }
}

module.exports = Queue;
