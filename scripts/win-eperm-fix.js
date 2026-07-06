/**
 * Preload script for Next.js build on Windows.
 * 
 * 1. Windows user profile directories contain legacy junction points and
 *    protected directories that deny scandir access (EPERM/EACCES). When Next.js
 *    traces files for standalone output, @vercel/nft's glob walks into
 *    these directories, causing unhandled rejections that crash the build.
 *    This script patches fs.readdir/readdirSync to return empty arrays on EPERM/EACCES.
 * 
 * 2. Windows-saved files can contain a UTF-8 BOM (Byte Order Mark, \uFEFF) at
 *    the beginning of the file. This causes JSON.parse() to throw syntax errors.
 *    This script patches fs.readFile/readFileSync/promises.readFile to strip BOM
 *    on UTF-8 file reads.
 */
if (process.platform === 'win32') {
  const fs = require('fs');

  // ==========================================
  // Part 1: Scandir EPERM/EACCES Fix
  // ==========================================

  // Patch readlink (used by @vercel/nft file tracing)
  const origReadlink = fs.readlink;
  fs.readlink = function patchedReadlink(p, ...args) {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      const wrappedCallback = function (err, link) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          return callback(null, ''); // Return empty string
        }
        return callback(err, link);
      };
      args[args.length - 1] = wrappedCallback;
      return origReadlink.call(fs, p, ...args);
    }
    return origReadlink.call(fs, p, ...args);
  };

  // Patch fs.promises.readlink
  if (fs.promises && fs.promises.readlink) {
    const origReadlinkPromise = fs.promises.readlink;
    fs.promises.readlink = async function patchedReadlinkPromise(p, ...args) {
      try {
        return await origReadlinkPromise.call(fs.promises, p, ...args);
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          return '';
        }
        throw err;
      }
    };
  }

  // Patch async readdir (callback-style, used by glob)
  const origReaddir = fs.readdir;
  fs.readdir = function patchedReaddir(p, ...args) {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      const wrappedCallback = function (err, files) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          return callback(null, []); // Return empty listing
        }
        return callback(err, files);
      };
      args[args.length - 1] = wrappedCallback;
      return origReaddir.call(fs, p, ...args);
    }
    return origReaddir.call(fs, p, ...args);
  };

  // Patch promise-based readdir (used by newer code)
  if (fs.promises) {
    const origReaddirPromise = fs.promises.readdir;
    fs.promises.readdir = async function patchedReaddirPromise(p, ...args) {
      try {
        return await origReaddirPromise.call(fs.promises, p, ...args);
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          return [];
        }
        throw err;
      }
    };
  }

  // Patch sync readdir (used by glob.sync)
  const origReaddirSync = fs.readdirSync;
  fs.readdirSync = function patchedReaddirSync(p, ...args) {
    try {
      return origReaddirSync.call(fs, p, ...args);
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        return [];
      }
      throw err;
    }
  };

  // ==========================================
  // Part 2: UTF-8 BOM Strip Fix
  // ==========================================

  const isUtf8Encoding = (options) => {
    if (typeof options === 'string') {
      return options === 'utf-8' || options === 'utf8';
    }
    if (options && typeof options === 'object') {
      return options.encoding === 'utf-8' || options.encoding === 'utf8';
    }
    return false;
  };

  // Patch fs.readFile (callback-style)
  const origReadFile = fs.readFile;
  fs.readFile = function patchedReadFile(p, ...args) {
    const callback = args[args.length - 1];
    const options = args[0];
    if (typeof callback === 'function') {
      const wrappedCallback = function (err, data) {
        if (!err && typeof data === 'string' && isUtf8Encoding(options)) {
          data = data.replace(/^\uFEFF/, '');
        }
        return callback(err, data);
      };
      args[args.length - 1] = wrappedCallback;
      return origReadFile.call(fs, p, ...args);
    }
    return origReadFile.call(fs, p, ...args);
  };

  // Patch fs.readFileSync
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(p, ...args) {
    let data = origReadFileSync.call(fs, p, ...args);
    const options = args[0];
    if (typeof data === 'string' && isUtf8Encoding(options)) {
      data = data.replace(/^\uFEFF/, '');
    }
    return data;
  };

  // Patch fs.promises.readFile
  if (fs.promises) {
    const origReadFilePromise = fs.promises.readFile;
    fs.promises.readFile = async function patchedReadFilePromise(p, ...args) {
      let data = await origReadFilePromise.call(fs.promises, p, ...args);
      const options = args[0];
      if (typeof data === 'string' && isUtf8Encoding(options)) {
        data = data.replace(/^\uFEFF/, '');
      }
      return data;
    };
  }
}
