/*
 *
 * Copyright 2015 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

'use strict';

var fs = require('fs');
var path = require('path');
var grpc = require('../any_grpc').client;
var protoLoader = require('../../packages/proto-loader');

const { GoogleAuth } = require('google-auth-library');

var protoPackage = protoLoader.loadSync(
    'src/proto/grpc/testing/test.proto',
    {keepCase: true,
     defaults: true,
     enums: String,
     includeDirs: [__dirname + '/../proto/']});
var testProto = grpc.loadPackageDefinition(protoPackage).grpc.testing;

var assert = require('assert');

var SERVICE_ACCOUNT_EMAIL;
try {
  SERVICE_ACCOUNT_EMAIL = require(
      process.env.GOOGLE_APPLICATION_CREDENTIALS).client_email;
} catch (e) {
  // This will cause the tests to fail if they need that string
  SERVICE_ACCOUNT_EMAIL = null;
}

var ECHO_INITIAL_KEY = 'x-grpc-test-echo-initial';
var ECHO_TRAILING_KEY = 'x-grpc-test-echo-trailing-bin';

/**
 * Create a buffer filled with size zeroes
 * @param {number} size The length of the buffer
 * @return {Buffer} The New Buffer
 */
function zeroBuffer(size) {
  var zeros = Buffer.alloc(size);
  zeros.fill(0);
  return zeros;
}

/**
 * This is used for testing functions with multiple asynchronous calls that
 * can happen in different orders. This should be passed the number of async
 * function invocations that can occur last, and each of those should call this
 * function's return value
 * @param {function()} done The function that should be called when a test is
 *     complete.
 * @param {number} count The number of calls to the resulting function if the
 *     test passes.
 * @return {function()} The function that should be called at the end of each
 *     sequence of asynchronous functions.
 */
function multiDone(done, count) {
  return function() {
    count -= 1;
    if (count <= 0) {
      done();
    }
  };
}

/**
 * Run the empty_unary test
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function emptyUnary(client, done) {
  client.emptyCall({}, function(err, resp) {
    assert.ifError(err);
    if (done) {
      done();
    }
  });
}

/**
 * Run the large_unary test
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function largeUnary(client, done) {
  var arg = {
    response_type: 'COMPRESSABLE',
    response_size: 314159,
    payload: {
      body: zeroBuffer(271828)
    }
  };
  client.unaryCall(arg, function(err, resp) {
    assert.ifError(err);
    assert.strictEqual(resp.payload.type, 'COMPRESSABLE');
    assert.strictEqual(resp.payload.body.length, 314159);
    if (done) {
      done();
    }
  });
}

/**
 * Run the client_streaming test
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function clientStreaming(client, done) {
  var call = client.streamingInputCall(function(err, resp) {
    assert.ifError(err);
    assert.strictEqual(resp.aggregated_payload_size, 74922);
    if (done) {
      done();
    }
  });
  var payload_sizes = [27182, 8, 1828, 45904];
  for (var i = 0; i < payload_sizes.length; i++) {
    call.write({payload: {body: zeroBuffer(payload_sizes[i])}});
  }
  call.end();
}

/**
 * Run the server_streaming test
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function serverStreaming(client, done) {
  var arg = {
    response_type: 'COMPRESSABLE',
    response_parameters: [
      {size: 31415},
      {size: 9},
      {size: 2653},
      {size: 58979}
    ]
  };
  var call = client.streamingOutputCall(arg);
  var resp_index = 0;
  call.on('data', function(value) {
    assert(resp_index < 4);
    assert.strictEqual(value.payload.type, 'COMPRESSABLE');
    assert.strictEqual(value.payload.body.length,
                       arg.response_parameters[resp_index].size);
    resp_index += 1;
  });
  call.on('end', function() {
    assert.strictEqual(resp_index, 4);
    if (done) {
      done();
    }
  });
  call.on('status', function(status) {
    assert.strictEqual(status.code, grpc.status.OK);
  });
}

/**
 * Run the ping_pong test
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function pingPong(client, done) {
  var payload_sizes = [27182, 8, 1828, 45904];
  var response_sizes = [31415, 9, 2653, 58979];
  var call = client.fullDuplexCall();
  call.on('status', function(status) {
    assert.strictEqual(status.code, grpc.status.OK);
    if (done) {
      done();
    }
  });
  var index = 0;
  call.write({
      response_type: 'COMPRESSABLE',
      response_parameters: [
        {size: response_sizes[index]}
      ],
      payload: {body: zeroBuffer(payload_sizes[index])}
  });
  call.on('data', function(response) {
    assert.strictEqual(response.payload.type, 'COMPRESSABLE');
    assert.equal(response.payload.body.length, response_sizes[index]);
    index += 1;
    if (index === 4) {
      call.end();
    } else {
      call.write({
        response_type: 'COMPRESSABLE',
        response_parameters: [
          {size: response_sizes[index]}
        ],
        payload: {body: zeroBuffer(payload_sizes[index])}
      });
    }
  });
}

/**
 * Run the empty_stream test.
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function emptyStream(client, done) {
  var call = client.fullDuplexCall();
  call.on('status', function(status) {
    assert.strictEqual(status.code, grpc.status.OK);
    if (done) {
      done();
    }
  });
  call.on('data', function(value) {
    assert.fail(value, null, 'No data should have been received', '!==');
  });
  call.end();
}

/**
 * Run the cancel_after_begin test.
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function cancelAfterBegin(client, done) {
  var call = client.streamingInputCall(function(err, resp) {
    assert.strictEqual(err.code, grpc.status.CANCELLED);
    done();
  });
  call.cancel();
}

/**
 * Run the cancel_after_first_response test.
 * @param {Client} client The client to test against
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function cancelAfterFirstResponse(client, done) {
  var call = client.fullDuplexCall();
  call.write({
      response_type: 'COMPRESSABLE',
      response_parameters: [
        {size: 31415}
      ],
      payload: {body: zeroBuffer(27182)}
  });
  call.on('data', function(data) {
    call.cancel();
  });
  call.on('error', function(error) {
    assert.strictEqual(error.code, grpc.status.CANCELLED);
    done();
  });
}

function timeoutOnSleepingServer(client, done) {
  var deadline = new Date();
  deadline.setMilliseconds(deadline.getMilliseconds() + 1);
  var call = client.fullDuplexCall({deadline: deadline});
  call.write({
    payload: {body: zeroBuffer(27182)}
  });
  call.on('data', function() {});
  call.on('error', function(error) {

    assert(error.code === grpc.status.DEADLINE_EXCEEDED ||
        error.code === grpc.status.INTERNAL);
    done();
  });
}

function customMetadata(client, done) {
  done = multiDone(done, 5);
  var metadata = new grpc.Metadata();
  metadata.set(ECHO_INITIAL_KEY, 'test_initial_metadata_value');
  metadata.set(ECHO_TRAILING_KEY, Buffer.from('ababab', 'hex'));
  var arg = {
    response_type: 'COMPRESSABLE',
    response_size: 314159,
    payload: {
      body: zeroBuffer(271828)
    }
  };
  var streaming_arg = {
    response_parameters: [
     {size: 314159}
    ],
    payload: {
      body: zeroBuffer(271828)
    }
  };
  var unary = client.unaryCall(arg, metadata, function(err, resp) {
    assert.ifError(err);
    done();
  });
  unary.on('metadata', function(metadata) {
    assert.deepEqual(metadata.get(ECHO_INITIAL_KEY),
                     ['test_initial_metadata_value']);
    done();
  });
  unary.on('status', function(status) {
    var echo_trailer = status.metadata.get(ECHO_TRAILING_KEY);
    assert(echo_trailer.length > 0);
    assert.strictEqual(echo_trailer[0].toString('hex'), 'ababab');
    done();
  });
  var stream = client.fullDuplexCall(metadata);
  stream.on('metadata', function(metadata) {
    assert.deepEqual(metadata.get(ECHO_INITIAL_KEY),
                     ['test_initial_metadata_value']);
    done();
  });
  stream.on('data', function() {});
  stream.on('status', function(status) {
    var echo_trailer = status.metadata.get(ECHO_TRAILING_KEY);
    assert(echo_trailer.length > 0);
    assert.strictEqual(echo_trailer[0].toString('hex'), 'ababab');
    done();
  });
  stream.write(streaming_arg);
  stream.end();
}

function statusCodeAndMessage(client, done) {
  done = multiDone(done, 2);
  var arg = {
    response_status: {
      code: 2,
      message: 'test status message'
    }
  };
  client.unaryCall(arg, function(err, resp) {
    assert(err);
    assert.strictEqual(err.code, 2);
    assert.strictEqual(err.details, 'test status message');
    done();
  });
  var duplex = client.fullDuplexCall();
  duplex.on('data', function() {});
  duplex.on('status', function(status) {
    assert(status);
    assert.strictEqual(status.code, 2);
    assert.strictEqual(status.details, 'test status message');
    done();
  });
  duplex.on('error', function(){});
  duplex.write(arg);
  duplex.end();
}

function specialStatusMessage(client, done) {
  let expectedMessage = '\t\ntest with whitespace\r\nand Unicode BMP ☺ and non-BMP 😈\t\n';
  let arg = {
    response_status: {
      code: 2,
      message: expectedMessage
    }
  };
  client.unaryCall(arg, function(err, resp) {
    assert(err);
    assert.strictEqual(err.code, 2);
    assert.strictEqual(err.details, expectedMessage);
    done();
  });
}

// NOTE: the client param to this function is from UnimplementedService
function unimplementedService(client, done) {
  client.unimplementedCall({}, function(err, resp) {
    assert(err);
    assert.strictEqual(err.code, grpc.status.UNIMPLEMENTED);
    done();
  });
}

// NOTE: the client param to this function is from TestService
function unimplementedMethod(client, done) {
  client.unimplementedCall({}, function(err, resp) {
    assert(err);
    assert.strictEqual(err.code, grpc.status.UNIMPLEMENTED);
    done();
  });
}

/**
 * Run one of the authentication tests.
 * @param {string} expected_user The expected username in the response
 * @param {Client} client The client to test against
 * @param {?string} scope The scope to apply to the credentials
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 */
function authTest(expected_user, scope, client, done) {
  var arg = {
    response_type: 'COMPRESSABLE',
    response_size: 314159,
    payload: {
      body: zeroBuffer(271828)
    },
    fill_username: true,
    fill_oauth_scope: true
  };
  client.unaryCall(arg, function(err, resp) {
    assert.ifError(err);
    assert.strictEqual(resp.payload.type, 'COMPRESSABLE');
    assert.strictEqual(resp.payload.body.length, 314159);
    assert.strictEqual(resp.username, expected_user);
    if (scope) {
      assert(scope.indexOf(resp.oauth_scope) > -1);
    }
    if (done) {
      done();
    }
  });
}

function computeEngineCreds(client, done, extra) {
  authTest(extra.service_account, null, client, done);
}

function serviceAccountCreds(client, done, extra) {
  authTest(SERVICE_ACCOUNT_EMAIL, extra.oauth_scope, client, done);
}

function jwtTokenCreds(client, done, extra) {
  authTest(SERVICE_ACCOUNT_EMAIL, null, client, done);
}

function oauth2Test(client, done, extra) {
  var arg = {
    fill_username: true,
    fill_oauth_scope: true
  };
  client.unaryCall(arg, function(err, resp) {
    assert.ifError(err);
    assert.strictEqual(resp.username, SERVICE_ACCOUNT_EMAIL);
    assert(extra.oauth_scope.indexOf(resp.oauth_scope) > -1);
    if (done) {
      done();
    }
  });
}

function perRpcAuthTest(client, done, extra) {
  var arg = {
    fill_username: true,
    fill_oauth_scope: true
  };
  const creds = grpc.credentials.createFromGoogleCredential(new GoogleAuth({scopes: extra.oauth_scope}));
  client.unaryCall(arg, {credentials: creds}, function(err, resp) {
    assert.ifError(err);
    assert.strictEqual(resp.username, SERVICE_ACCOUNT_EMAIL);
    assert(extra.oauth_scope.indexOf(resp.oauth_scope) > -1);
    if (done) {
      done();
    }
  });
}

function getApplicationCreds(scope, callback) {
  callback(null, grpc.credentials.createFromGoogleCredential(new GoogleAuth({scopes: scope})));
}

function getOauth2Creds(scope, callback) {
  (new GoogleAuth({scopes: scope})).getAccessToken().then((token) => {
    var updateMd = function(service_url, callback) {
      var metadata = new grpc.Metadata();
      metadata.add('authorization', 'Bearer ' + token);
      callback(null, metadata);
    };
    callback(null, grpc.credentials.createFromMetadataGenerator(updateMd));
  }, (error) => {
    callback(error);
  });
}

/**
 * Map from test case names to test functions
 */
var test_cases = {
  empty_unary: {run: emptyUnary,
                Client: testProto.TestService},
  large_unary: {run: largeUnary,
                Client: testProto.TestService},
  client_streaming: {run: clientStreaming,
                     Client: testProto.TestService},
  server_streaming: {run: serverStreaming,
                     Client: testProto.TestService},
  ping_pong: {run: pingPong,
              Client: testProto.TestService},
  empty_stream: {run: emptyStream,
                 Client: testProto.TestService},
  cancel_after_begin: {run: cancelAfterBegin,
                       Client: testProto.TestService},
  cancel_after_first_response: {run: cancelAfterFirstResponse,
                                Client: testProto.TestService},
  timeout_on_sleeping_server: {run: timeoutOnSleepingServer,
                               Client: testProto.TestService},
  custom_metadata: {run: customMetadata,
                    Client: testProto.TestService},
  status_code_and_message: {run: statusCodeAndMessage,
                            Client: testProto.TestService},
  special_status_message: {run: specialStatusMessage,
                           Client: testProto.TestService},
  unimplemented_service: {run: unimplementedService,
                         Client: testProto.UnimplementedService},
  unimplemented_method: {run: unimplementedMethod,
                         Client: testProto.TestService},
  compute_engine_creds: {run: computeEngineCreds,
                         Client: testProto.TestService,
                         getCreds: getApplicationCreds},
  service_account_creds: {run: serviceAccountCreds,
                          Client: testProto.TestService,
                          getCreds: getApplicationCreds},
  jwt_token_creds: {run: jwtTokenCreds,
                    Client: testProto.TestService,
                    getCreds: getApplicationCreds},
  oauth2_auth_token: {run: oauth2Test,
                      Client: testProto.TestService,
                      getCreds: getOauth2Creds},
  per_rpc_creds: {run: perRpcAuthTest,
                  Client: testProto.TestService}
};

exports.test_cases = test_cases;

/**
 * Execute a single test case.
 * @param {string} address The address of the server to connect to, in the
 *     format 'hostname:port'
 * @param {string} host_overrirde The hostname of the server to use as an SSL
 *     override
 * @param {string} test_case The name of the test case to run
 * @param {bool} tls Indicates that a secure channel should be used
 * @param {function} done Callback to call when the test is completed. Included
 *     primarily for use with mocha
 * @param {object=} extra Extra options for some tests
 */
function runTest(address, host_override, test_case, tls, test_ca, done, extra) {
  // TODO(mlumish): enable TLS functionality
  var options = {};
  var creds;
  if (tls) {
    var ca_path;
    if (test_ca) {
      ca_path = path.join(__dirname, '../data/ca.pem');
      var ca_data = fs.readFileSync(ca_path);
      creds = grpc.credentials.createSsl(ca_data);
    } else {
      creds = grpc.credentials.createSsl();
    }
    if (host_override) {
      options['grpc.ssl_target_name_override'] = host_override;
      options['grpc.default_authority'] = host_override;
    }
  } else {
    creds = grpc.credentials.createInsecure();
  }
  var test = test_cases[test_case];

  var execute = function(err, creds) {
    assert.ifError(err);
    var client = new test.Client(address, creds, options);
    test.run(client, done, extra);
  };

  if (test.getCreds) {
    test.getCreds(extra.oauth_scope, function(err, new_creds) {
      assert.ifError(err);
      execute(err, grpc.credentials.combineChannelCredentials(
          creds, new_creds));
    });
  } else {
    execute(null, creds);
  }
}

if (require.main === module) {
  var parseArgs = require('minimist');
  var argv = parseArgs(process.argv, {
    string: ['server_host', 'server_host_override', 'server_port', 'test_case',
             'use_tls', 'use_test_ca', 'default_service_account', 'oauth_scope',
             'service_account_key_file']
  });
  var extra_args = {
    service_account: argv.default_service_account,
    oauth_scope: argv.oauth_scope
  };
  runTest(argv.server_host + ':' + argv.server_port, argv.server_host_override,
          argv.test_case, argv.use_tls === 'true', argv.use_test_ca === 'true',
          function (err) {
            if (err) {
              throw err;
            } else {
              console.log('OK:', argv.test_case);
            }
          }, extra_args);
}

/**
 * See docs for runTest
 */
exports.runTest = runTest;
