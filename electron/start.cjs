// Goldline Takeoff starts here on a copy installed by the Goldline Takeoff setup (package.json
// "main"): the copy the setup installed, or a newer one the app downloaded (starter.cjs). Kept tiny
// and unchanging: it is the part that can't be updated without the setup.
// (A PC set up before Goldline Takeoff starts through its old resources\app\boot.cjs instead, which
// loads versions\<v>\electron\main.cjs: main.cjs runs starter.cjs itself then.)
'use strict';
require('./starter.cjs').start({ builtinDir: require('path').join(__dirname, '..') });
