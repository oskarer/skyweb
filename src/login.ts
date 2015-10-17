/// <reference path='../typings/node/node.d.ts' />
/// <reference path='../typings/form-data/form-data.d.ts' />
/// <reference path='../typings/cheerio/cheerio.d.ts' />
/// <reference path='../typings/request/request.d.ts' />
/// <reference path='../typings/es6-promise/es6-promise.d.ts' />
import request = require('request');
require('request-persistent')(request);
import cheerio = require('cheerio');
import Utils = require('./utils');
import SkypeAccount = require('./skype_account');
import Consts = require('./consts');
import http = require('http');
import url = require('url');
import {CookieJar} from "request";

'use strict';

class Login {
    private requestWithJar;
    private jar;

    constructor(cookieJar:CookieJar) {
        this.requestWithJar = request.defaults({jar: cookieJar});
        this.jar = cookieJar;
    }

    public doLogin(skypeAccount:SkypeAccount) {
        var functions = [new Promise(this.sendLoginRequest.bind(this, skypeAccount)), this.getRegistrationToken, this.subscribeToResources, this.getSelfDisplayName];

        return <Promise<{}>>(functions.reduce((previousValue:Promise<{}>, currentValue)=> {
            return previousValue.then((skypeAccount:SkypeAccount) => {
                return new Promise(currentValue.bind(this, skypeAccount));
            });
        }));
    }

    private sendLoginRequest(skypeAccount:SkypeAccount, resolve, reject) {
        this.requestWithJar.get(Consts.SKYPEWEB_LOGIN_URL, (error, response, body) => {
            if (!error && response.statusCode == 200) {
                var $ = cheerio.load(body);

                //we'll need those values to do successful auth
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

                console.log(request.jar())
                // console.log(this.jar.toJSON())
                //auth step
                this.requestWithJar.post(postParams, (error, response, body) => {
                    if (!error && response.statusCode == 200) {
                        var $ = cheerio.load(body);
                        skypeAccount.skypeToken = $('input[name="skypetoken"]').val();
                        skypeAccount.skypeTokenExpiresIn = parseInt($('input[name="expires_in"]').val());//86400 by default
                        if (skypeAccount.skypeToken && skypeAccount.skypeTokenExpiresIn){
                            resolve(skypeAccount);
                            console.log(this.jar.toJSON())
                        } else {
                            Utils.throwError('Failed to get skypetoken. Username or password is incorrect OR you\'ve' +
                                ' hit a CAPTCHA wall.' + $('.message_error').text());
                        }
                    } else {
                        Utils.throwError('Failed to get skypetoken');
                    }

                });
            } else {
                Utils.throwError('Failed to get pie and etm. Login failed.');
            }
        });
    }

    private getRegistrationToken(skypeAccount:SkypeAccount, resolve, reject) {
        var currentTime = Utils.getCurrentTime();
        var lockAndKeyResponse = Utils.getMac256Hash(currentTime, Consts.SKYPEWEB_LOCKANDKEY_APPID, Consts.SKYPEWEB_LOCKANDKEY_SECRET);
        this.requestWithJar.post(Consts.SKYPEWEB_HTTPS + skypeAccount.messagesHost + '/v1/users/ME/endpoints', {
            headers: {
                'LockAndKey': 'appId=' + Consts.SKYPEWEB_LOCKANDKEY_APPID + '; time=' + currentTime + '; lockAndKeyResponse=' + lockAndKeyResponse,
                'ClientInfo': 'os=Windows; osVer=10; proc=Win64; lcid=en-us; deviceType=1; country=n/a; clientName=' + Consts.SKYPEWEB_CLIENTINFO_NAME + '; clientVer=' + Consts.SKYPEWEB_CLIENTINFO_VERSION,
                'Authentication': 'skypetoken=' + skypeAccount.skypeToken
            },
            body: '{}' //don't ask why
        }, (error:any, response:http.IncomingMessage, body:any) => {
            //now lets try retrieve registration token
            if (!error && response.statusCode === 201 || response.statusCode === 301) {
                var locationHeader = response.headers['location'];
                //expecting something like this 'registrationToken=someSting; expires=someNumber; endpointId={someString}'
                var registrationTokenHeader = response.headers['set-registrationtoken'];
                var location = url.parse(locationHeader);
                if (location.host !== skypeAccount.messagesHost) { //mainly when 301, but sometimes when 201
                    skypeAccount.messagesHost = location.host;
                    //looks like messagesHost has changed?
                    this.getRegistrationToken(skypeAccount, resolve, reject);
                    return;
                }

                var registrationTokenParams = registrationTokenHeader.split(/\s*;\s*/).reduce((params, current:string) => {
                    if (current.indexOf('registrationToken') === 0) {
                        params['registrationToken'] = current;
                    } else {
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

                //fixme add endpoint and expires!
                resolve(skypeAccount)

            } else {
                Utils.throwError('Failed to get registrationToken.');
            }
        });
    }

    private subscribeToResources(skypeAccount:SkypeAccount, resolve, reject) {
        var interestedResources = [
            '/v1/threads/ALL',
            '/v1/users/ME/contacts/ALL',
            '/v1/users/ME/conversations/ALL/messages',
            '/v1/users/ME/conversations/ALL/properties'
        ];
        var requestBody = JSON.stringify({
            interestedResources: interestedResources,
            template: 'raw',
            channelType: 'httpLongPoll'//todo web sockets maybe ?
        });

        this.requestWithJar.post(Consts.SKYPEWEB_HTTPS + skypeAccount.messagesHost + '/v1/users/ME/endpoints/SELF/subscriptions', {
            body: requestBody,
            headers: {
                'RegistrationToken': skypeAccount.registrationTokenParams.raw
            }
        }, (error:any, response:http.IncomingMessage, body:any) => {
            if (!error && response.statusCode === 201) {
                resolve(skypeAccount);
            } else {
                Utils.throwError('Failed to subscribe to resources.');
            }
        });
    }

    private getSelfDisplayName(skypeAccout:SkypeAccount, resolve, reject) {
        this.requestWithJar.get(Consts.SKYPEWEB_HTTPS + Consts.SKYPEWEB_API_SKYPE_HOST + Consts.SKYPEWEB_SELF_DISPLAYNAME_URL, {
            headers: {
                'X-Skypetoken': skypeAccout.skypeToken
            }
        }, function (error:any, response:http.IncomingMessage, body:any) {
            if (!error && response.statusCode == 200) {
                skypeAccout.selfInfo = JSON.parse(body);
                resolve(skypeAccout);
            } else {
                Utils.throwError('Failed to get selfInfo.');
            }
        });
    }
}

export = Login;
