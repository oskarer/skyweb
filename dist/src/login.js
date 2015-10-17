/// <reference path='../typings/node/node.d.ts' />
/// <reference path='../typings/form-data/form-data.d.ts' />
/// <reference path='../typings/cheerio/cheerio.d.ts' />
/// <reference path='../typings/request/request.d.ts' />
/// <reference path='../typings/es6-promise/es6-promise.d.ts' />
var request = require('request');
require('request-persistent')(request);
var cheerio = require('cheerio');
var Utils = require('./utils');
var Consts = require('./consts');
var url = require('url');
'use strict';
var Login = (function () {
    function Login(cookieJar) {
        this.requestWithJar = request.defaults({ jar: cookieJar });
        this.jar = cookieJar;
    }
    Login.prototype.doLogin = function (skypeAccount) {
        var _this = this;
        var functions = [new Promise(this.sendLoginRequest.bind(this, skypeAccount)), this.getRegistrationToken, this.subscribeToResources, this.getSelfDisplayName];
        return (functions.reduce(function (previousValue, currentValue) {
            return previousValue.then(function (skypeAccount) {
                return new Promise(currentValue.bind(_this, skypeAccount));
            });
        }));
    };
    Login.prototype.sendLoginRequest = function (skypeAccount, resolve, reject) {
        var _this = this;
        this.requestWithJar.get(Consts.SKYPEWEB_LOGIN_URL, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                var $ = cheerio.load(body);
                var pie = $('input[name="pie"]').val();
                var etm = $('input[name="etm"]').val();
                if (!pie || !etm) {
                    Utils.throwError('Failed to find pie or etm.');
                }
                var postParams = {
                    url: Consts.SKYPEWEB_LOGIN_URL,
                    form: {
                        username: skypeAccount.username,
                        password: skypeAccount.password,
                        pie: pie,
                        etm: etm,
                        timezone_field: Utils.getTimezone(),
                        js_time: Utils.getCurrentTime()
                    }
                };
                console.log(request.jar());
                _this.requestWithJar.post(postParams, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                        var $ = cheerio.load(body);
                        skypeAccount.skypeToken = $('input[name="skypetoken"]').val();
                        skypeAccount.skypeTokenExpiresIn = parseInt($('input[name="expires_in"]').val());
                        if (skypeAccount.skypeToken && skypeAccount.skypeTokenExpiresIn) {
                            resolve({ skypeAccount: skypeAccount, cookie: _this.jar.toJSON() });
                        }
                        else {
                            Utils.throwError('Failed to get skypetoken. Username or password is incorrect OR you\'ve' +
                                ' hit a CAPTCHA wall.' + $('.message_error').text());
                        }
                    }
                    else {
                        Utils.throwError('Failed to get skypetoken');
                    }
                });
            }
            else {
                Utils.throwError('Failed to get pie and etm. Login failed.');
            }
        });
    };
    Login.prototype.getRegistrationToken = function (skypeAccount, resolve, reject) {
        var _this = this;
        var currentTime = Utils.getCurrentTime();
        var lockAndKeyResponse = Utils.getMac256Hash(currentTime, Consts.SKYPEWEB_LOCKANDKEY_APPID, Consts.SKYPEWEB_LOCKANDKEY_SECRET);
        this.requestWithJar.post(Consts.SKYPEWEB_HTTPS + skypeAccount.messagesHost + '/v1/users/ME/endpoints', {
            headers: {
                'LockAndKey': 'appId=' + Consts.SKYPEWEB_LOCKANDKEY_APPID + '; time=' + currentTime + '; lockAndKeyResponse=' + lockAndKeyResponse,
                'ClientInfo': 'os=Windows; osVer=10; proc=Win64; lcid=en-us; deviceType=1; country=n/a; clientName=' + Consts.SKYPEWEB_CLIENTINFO_NAME + '; clientVer=' + Consts.SKYPEWEB_CLIENTINFO_VERSION,
                'Authentication': 'skypetoken=' + skypeAccount.skypeToken
            },
            body: '{}'
        }, function (error, response, body) {
            if (!error && response.statusCode === 201 || response.statusCode === 301) {
                var locationHeader = response.headers['location'];
                var registrationTokenHeader = response.headers['set-registrationtoken'];
                var location = url.parse(locationHeader);
                if (location.host !== skypeAccount.messagesHost) {
                    skypeAccount.messagesHost = location.host;
                    _this.getRegistrationToken(skypeAccount, resolve, reject);
                    return;
                }
                var registrationTokenParams = registrationTokenHeader.split(/\s*;\s*/).reduce(function (params, current) {
                    if (current.indexOf('registrationToken') === 0) {
                        params['registrationToken'] = current;
                    }
                    else {
                        var index = current.indexOf('=');
                        if (index > 0) {
                            params[current.substring(0, index)] = current.substring(index + 1);
                        }
                    }
                    return params;
                }, {
                    raw: registrationTokenHeader
                });
                if (!registrationTokenParams.registrationToken || !registrationTokenParams.expires || !registrationTokenParams.endpointId) {
                    Utils.throwError('Failed to find registrationToken or expires or endpointId.');
                }
                registrationTokenParams.expires = parseInt(registrationTokenParams.expires);
                skypeAccount.registrationTokenParams = registrationTokenParams;
                resolve(skypeAccount);
            }
            else {
                Utils.throwError('Failed to get registrationToken.');
            }
        });
    };
    Login.prototype.subscribeToResources = function (skypeAccount, resolve, reject) {
        var interestedResources = [
            '/v1/threads/ALL',
            '/v1/users/ME/contacts/ALL',
            '/v1/users/ME/conversations/ALL/messages',
            '/v1/users/ME/conversations/ALL/properties'
        ];
        var requestBody = JSON.stringify({
            interestedResources: interestedResources,
            template: 'raw',
            channelType: 'httpLongPoll'
        });
        this.requestWithJar.post(Consts.SKYPEWEB_HTTPS + skypeAccount.messagesHost + '/v1/users/ME/endpoints/SELF/subscriptions', {
            body: requestBody,
            headers: {
                'RegistrationToken': skypeAccount.registrationTokenParams.raw
            }
        }, function (error, response, body) {
            if (!error && response.statusCode === 201) {
                resolve(skypeAccount);
            }
            else {
                Utils.throwError('Failed to subscribe to resources.');
            }
        });
    };
    Login.prototype.getSelfDisplayName = function (skypeAccout, resolve, reject) {
        this.requestWithJar.get(Consts.SKYPEWEB_HTTPS + Consts.SKYPEWEB_API_SKYPE_HOST + Consts.SKYPEWEB_SELF_DISPLAYNAME_URL, {
            headers: {
                'X-Skypetoken': skypeAccout.skypeToken
            }
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                skypeAccout.selfInfo = JSON.parse(body);
                resolve(skypeAccout);
            }
            else {
                Utils.throwError('Failed to get selfInfo.');
            }
        });
    };
    return Login;
})();
module.exports = Login;
