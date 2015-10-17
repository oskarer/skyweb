var Skyweb = require('../skyweb');
var username = process.argv[2];
var password = process.argv[3];
if (!username || !password) {
    throw new Error('Username and password should be provided as commandline arguments!');
}
var skyweb = new Skyweb();
skyweb.login(username, password).then(function (response) {
    console.log(response);
    console.log('Skyweb is initialized now');
    console.log('Here is some info about you:' + JSON.stringify(skyweb.skypeAccount.selfInfo, null, 2));
});
