const DEBUG = process.env.NODE_ENV === 'debug';
module.exports = (...args) => { if (DEBUG) console.log(...args); };
