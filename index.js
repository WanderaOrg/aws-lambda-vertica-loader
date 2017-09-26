/*
		Copyright 2014-2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.

    Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at

        http://aws.amazon.com/asl/

    or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/*
 * May 2015
 *
 * Derivative created by HP, to leverage and extend the function framework to provide automatic loading from S3, via
 * Lambda, to the HP Vertica Analytic Database platform. This derivative work remains governed by the Amazon
 * Software License, and is subject to all terms and restrictions noted in ASL.
 *
 */

var region = process.env['AWS_REGION'];

if (!region || region === null || region === "") {
	region = "us-east-1";
	console.log("AWS Lambda Vertica Database Loader using default region " + region);
}

var aws = require('aws-sdk');
aws.config.update({
	region : region
});
var s3 = new aws.S3({
	apiVersion : '2006-03-01',
	region : region
});
var sns = new aws.SNS({
	apiVersion : '2010-03-31',
	region : region
});
require('./constants');
var kmsCrypto = require('./kmsCrypto');
kmsCrypto.setRegion(region);
var common = require('./common');
var async = require('async');
var uuid = require('node-uuid');
var vertica = require('vertica');
var Persistence = require('./db/persistence');
var postgresClient;

function done(context, error, msg) {
  if (postgresClient) {
    console.info("Closing connection to Postgres DB");
    postgresClient.end();
  }

  context.done(error, msg);
}

// main function for AWS Lambda
exports.handler =
		function(event, context) {
			/** runtime functions * */
			/* callback run when we find a configuration for load in Dynamo DB */
			exports.foundConfig =
					function(s3Info, err, data) {
						if (err) {
							console.error(err);
							var msg = 'Error getting Vertica Configuration for ' + s3Info.prefix + ' from Postgres ';
							console.error(msg);
							done(context, error, msg);
						}

						if (!data) {
							// finish with no exception - where this file sits
							// in the S3
							// structure is not configured for loads
							console.warn("No Configuration Found for " + s3Info.prefix);

							done(context, null, null);
						} else {
							console.info("Found Vertica Load Configuration for " + s3Info.prefix);

							var config = data;
							var thisBatchId = config.currentbatch;
							if (config.filenamefilterregex) {
								if (s3Info.key.match(config.filenamefilterregex)) {
									exports.checkFileProcessed(config, thisBatchId, s3Info);
								} else {
									console.info('Object ' + s3Info.key + ' excluded by filename filter \''
											+ config.filenamefilterregex + '\'');

									// scan the current batch to decide
									// if it needs to
									// be
									// flushed due to batch timeout
									exports.processPendingBatch(config, thisBatchId, s3Info);
								}
							} else {
								// no filter, so we'll load the data
								exports.checkFileProcessed(config, thisBatchId, s3Info);
							}
						}
					};

			/*
			 * function to add a file to the pending batch set and then call the
			 * success callback
			 */
			exports.checkFileProcessed = function(config, thisBatchId, s3Info) {
				var itemEntry = s3Info.bucket + '/' + s3Info.key;

				// perform the idempotency check for the file
				// add the file to the processed list
				Persistence.putFileEntry(postgresClient, itemEntry, function(err, data) {
					if (err) {
						// the conditional check failed so the file has already
						// been
						// processed
						console.info("File " + itemEntry + " Already Processed");
						done(context, null, null);
					} else {
						if (!data) {
							var msg = "Idempotency Check on " + itemEntry + " failed";
							console.info(msg);
							exports.failBatch(msg, config, thisBatchId, s3Info, undefined);
						} else {
							// add was OK - proceed with adding the entry to the
							// pending batch
							exports.addFileToPendingBatch(config, thisBatchId, s3Info, itemEntry);
						}
					}
				});
			};

			/**
			 * Function run to add a file to the existing open batch. This will
			 * repeatedly try to write and if unsuccessful it will requery the batch
			 * ID on the configuration
			 */
			exports.addFileToPendingBatch =
					function(config, thisBatchId, s3Info, itemEntry) {
						console.info("Adding Pending Batch Entry for " + itemEntry);

						var proceed = false;
						var asyncError = undefined;
						var addFileRetryLimit = 100;
						var tryNumber = 0;

						async
								.whilst(
										function() {
											// return OK if the proceed flag has
											// been set, or if we've hit the
											// retry count
											return !proceed && tryNumber < addFileRetryLimit;
										},
										function(callback) {
											tryNumber++;

											// build the reference to the
											// pending batch, with an
											// atomic add of the current file
											var item = {
												batchid : thisBatchId,
												s3prefix : s3Info.prefix,
												entry: itemEntry,
												lastupdate: common.now(),
												status: open
											};

											// add the file to the pending batch
											Persistence.updateBatch(postgresClient, item, function(err) {
												if (err) {
													if (err.code === conditionCheckFailed) {
														/*
														 * the batch I have a reference to was locked so
														 * reload the current batch ID from the config
														 */
														Persistence.getConfig(postgresClient, s3Info.prefix, function(err, data) {
															if (err) {
																console.error(err);
																callback(err);
															} else {
																/*
																 * reset the batch ID to the current marked
																 * batch
																 */
																thisBatchId = data.currentbatch;

																/*
																 * we've not set proceed to true, so async will
																 * retry
																 */
																console.info("Reload of Configuration Complete after attempting Locked Batch Write");

																/*
																 * we can call into the callback with some random delay, as
																 * we probably just missed the pending batch
																 * processor's rotate of the configuration batch
																 * ID
																 */
																const waitTimeout = Math.random() * 300;
																setTimeout(callback, waitTimeout);
															}
														});
													} else {
														asyncError = err;
														proceed = true;
														callback();
													}
												} else {
													/*
													 * no error - the file was added to the batch, so mark
													 * the operation as OK so async will not retry
													 */
													proceed = true;
													callback();
												}
											});
										},
										function(err) {
											if (err) {
												// throw presented errors
												console.error(err);
												done(context, error, err);
											} else {
												if (asyncError) {
													/*
													 * throw errors which were encountered during the
													 * async calls
													 */
													console.error(asyncError);
													done(context, error, asyncError);
												} else {
													if (!proceed) {
														/*
														 * process what happened if the iterative request to
														 * write to the open pending batch timed out
														 * 
														 * TODO Can we force a rotation of the current batch
														 * at this point?
														 */
														var e =
																"Unable to write "
																		+ itemEntry
																		+ " in "
																		+ addFileRetryLimit
																		+ " attempts. Failing further processing to Batch "
																		+ thisBatchId
																		+ " which may be stuck in '"
																		+ locked
																		+ "' state. If so, unlock the back using `node unlockBatch.js <batch ID>`, delete the processed file marker with `node processedFiles.js -d <filename>`, and then re-store the file in S3";
														console.error(e);
														if (config.failuretopicarn) {
																exports.sendSNS(config.failuretopicarn,
																	"Lambda Vertica Loader unable to write to Open Pending Batch", e, function() {
																	done(context, error, e);
																}, function(err) {
																	console.error(err);
																	done(context, error, "Unable to Send SNS Notification");
														 		});
														}
													} else {
														// the add of the file was successful, so we
														exports.linkProcessedFileToBatch(itemEntry, thisBatchId);
														// which is async, so may fail but we'll still sweep
														// the pending batch
														exports.processPendingBatch(config, thisBatchId, s3Info);
													}
												}
											}
										});
					};

			/**
			 * Function which will link the deduplication table entry for the file to
			 * the batch into which the file was finally added
			 */
			exports.linkProcessedFileToBatch = function(itemEntry, batchid) {
				Persistence.linkFileToBatch(postgresClient, itemEntry, batchid, function(err) {
					// because this is an async call which doesn't affect
					// process flow, we'll just log the error and do nothing with the OK
					// response
					if (err) {
						console.error(err);
					}
				});
			};

			/**
			 * Function to process the current pending batch, and create a batch load
			 * process if required on the basis of size or timeout
			 */
			exports.processPendingBatch =
					function(config, thisBatchId, s3Info) {
						// make the request for the current batch
						Persistence.getBatch(postgresClient, thisBatchId, s3Info.prefix,
								function(err, data) {
									if (err) {
										console.error(err);
										done(context, error, err);
									} else if (!data) {
										var msg = "No open pending Batch " + thisBatchId;
										console.info(msg);
										done(context, null, msg);
									} else {
										// check whether the current batch is bigger than the
										// configured max size, or older than configured max age
										var lastupdateTime = data.lastupdate;
										var pendingEntries = data.entries;
										var doProcessBatch = false;
										if (pendingEntries.length >= parseInt(config.batchsize)) {
											console.info("Batch Size " + config.batchsize + " reached");
											doProcessBatch = true;
										}

										if (config.batchtimeoutsecs) {
											if (common.now() - lastupdateTime > parseInt(config.batchtimeoutsecs)
													&& pendingEntries.length > 0) {
												console.info("Batch Size " + config.batchsize + " not reached but reached Age "
														+ config.batchtimeoutsecs + " seconds");
												doProcessBatch = true;
											}
										}

										if (doProcessBatch) {
											// set the current batch to locked status
											var updateCurrentBatchStatus = {
												batchid : thisBatchId,
												s3prefix : s3Info.prefix,
												status :  locked,
												lastupdate :  common.now()
											};
											Persistence.lockBatch(postgresClient, updateCurrentBatchStatus, function(err, data) {
												if (err) {
													if (err.code === conditionCheckFailed) {
														/*
														 * some other Lambda function has locked the batch -
														 * this is OK and we'll just exit quietly
														 */
														done(context, null, null);
													} else {
														console.error("Unable to lock Batch " + thisBatchId);
														done(context, error, err);
													}
												} else {
													if (!data) {
														var e = "Unable to extract latest pending entries set from Locked batch";
														console.error(e);
														done(context, error, e);
													} else {
														/*
														 * grab the pending entries from the locked batch
														 */
														pendingEntries = data.entries;

														/*
														 * assign the loaded configuration a new batch ID
														 */
														var allocateNewBatchRequest = {
															s3prefix : s3Info.prefix,
															currentbatch : uuid.v4(),
															lastbatchrotation : common.now()
														};

														Persistence.allocateBatch(postgresClient, allocateNewBatchRequest, function(err) {
															if (err) {
																console.error("Error while allocating new Pending Batch ID");
																console.error(err);
																done(context, error, err);
															} else {
																// OK - let's create the load config
																exports.createLoadConfig(config, thisBatchId, s3Info, pendingEntries);
															}
														});
													}
												}
											});
										} else {
											console.info("No pending batch flush required");
											done(context, null, null);
										}
									}
								});
					};

			/**
			 * Function which will create the load configuration for a given batch and entries
			 */
			exports.createLoadConfig =
					function(config, thisBatchId, s3Info, batchEntries) {
						console.info("Creating Load configuration for Batch " + thisBatchId);

						// create list of file paths for Vertica COPY
						var copyPathList = "";

						for (var i = 0; i < batchEntries.length; i++) {
							// copyPath used for Vertica loads - S3 bucket must be mounted on cluster servers 
							// as: serverS3BucketMountDir/<bucketname> (see constants.js)
							var copyPathItem =  config.s3mountdir + batchEntries[i].replace('+', ' ').replace('%2B', '+');
							if (!copyPathList) {
                                                                copyPathList = copyPathItem;
							} else {
								copyPathList += '|' + copyPathItem;
							}
						}
						exports.loadVertica(config, thisBatchId, s3Info, copyPathList);
					};

			/**
			 * Function run to invoke loading
			 */
			exports.loadVertica = function(config, thisBatchId, s3Info, copyPathList) {
				// convert the config.loadclusters list into a format that
				// looks like a native dynamo entry
				var clustersToLoad = [];
				for (var i = 0; i < config.loadclusters.length; i++) {
					clustersToLoad[clustersToLoad.length] = config.loadclusters[i];
				}

				console.info("Loading " + clustersToLoad.length + " Clusters");

				// run all the cluster loaders in parallel
				async.map(clustersToLoad, function(item, callback) {
					// call the load cluster function, passing it the
					// continuation callback
					exports.loadCluster(config, thisBatchId, s3Info, copyPathList, item, callback);
				}, function(err, results) {
					if (err) {
						console.error(err);
					}

					// go through all the results - if they were all OK,
					// then close the batch OK - otherwise fail
					var allOK = true;
					var loadState = {};
					var loadStatements = {};

					for (var i = 0; i < results.length; i++) {
						if (!results[i] || results[i].status === ERROR) {
							var allOK = false;
							
							console.error("Cluster Load Failure " + results[i].error + " on Cluster " + results[i].cluster);
						} 
						// log the response state for each cluster
						loadState[results[i].cluster] = {
							status : results[i].status,
							error : results[i].error
						};
						loadStatements[results[i].cluster] = {
							preLoadStmt: results[i].preLoadStmt,
							loadStmt: results[i].loadStmt,
							postLoadStmt: results[i].postLoadStmt
						};
					}

					var loadStateRequest = {
						batchid : thisBatchId,
						s3prefix : s3Info.prefix,
						clusterloadstatus : JSON.stringify(loadState),
						clusterloadstatements:  JSON.stringify(loadStatements),
						lastupdate : common.now()
					};

					Persistence.changeLoadState(postgresClient, loadStateRequest, function(err) {
						if (err) {
							console.error("Error while attaching per-Cluster Load State");
							exports.failBatch(err, config, thisBatchId, s3Info, loadStatements);
						} else {
							if (allOK === true) {
								// close the batch as OK
								exports.closeBatch(null, config, thisBatchId, s3Info, loadStatements);
							} else {
								// close the batch as failure
								exports.failBatch(loadState, config, thisBatchId, s3Info, loadStatements);
							}
						}
					});
				});
			};

      /**
       * Function which chains multiple statements
			 * Returns the result of the last one
       *
       */
      exports.chainStatements =
        function (client, statements, callback) {
          var chainTail = Promise.resolve();

          statements.forEach(function (statement) {
          	console.info("Chaining statement ", statement);
            var newPromise = new Promise(function (resolve, reject) {
              client.query(statement, function (err, result) {
                err ? reject(err) : resolve(result);
              });
            });
            chainTail.then(newPromise);
            chainTail = newPromise;
          });

          chainTail
            .then(function (result) {
              callback(null, result);
            })
            .catch(function (err) {
              callback(err, null);
            });
        };

			/**
			 * Function which loads a Vertica cluster
			 *
			 */
			exports.loadCluster =
					function(config, thisBatchId, s3Info, copyPathList, clusterInfo, callback) {

						/* build the Vertica copy command */
						var copyCommand = '';
						// decrypt the encrypted items
						var encryptedItems = [ kmsCrypto.stringToBuffer(clusterInfo.connectPassword) ];
						kmsCrypto.decryptAll(encryptedItems, function(err, decryptedConfigItems) {
							if (err) {
								callback(err, {
									status : ERROR,
									cluster : clusterInfo.clusterEndpoint
								});
							} else {
								copyCommand = copyCommand + 'COPY ' + clusterInfo.targetTable;

								var columns = clusterInfo.copyColumns;
								if (columns) {
									copyCommand += ' (' + columns + ') ';
								}

								copyCommand += 'source S3(url=\'' + copyPathList + '\')';

								// add optional copy options
								if (config.copyoptions) {
									copyCommand = copyCommand + ' ' + config.copyoptions + '\n';
								}


								// build the connection string
								console.info("Connecting to Vertica Database " + clusterInfo.clusterEndpoint + ":" + clusterInfo.clusterPort);
								var dbConnectArgs = {
									host: clusterInfo.clusterEndpoint,
									port: clusterInfo.clusterPort,
									user: clusterInfo.connectUser,
									password: decryptedConfigItems[0].toString()
								} ;
								/*
								 * connect to database and run the copy command set
								 */
								var client = vertica.connect(
										dbConnectArgs,
										function(err, client, done) {
									if (err) {
										callback(null, {
											status : ERROR,
											error : err,
											cluster : clusterInfo.clusterEndpoint
										});
									} else {
										console.info("Connected") ;
										var preLoad = "" ;
										var load = "" ;
										var postLoad = "" ;
										// Run preLoad Statement, if defined - failure will not affect batch state
										if (clusterInfo.preLoadStatement !== undefined) {
											var statement = clusterInfo.preLoadStatement ;
											console.info("Execute preLoadStatement: " + statement) ;
											client.query(statement, function(err, result) {
												if (err) {
													console.error("preLoadStatement: Failed");
													preLoad = "Failed: " + statement ;
												} else {
													console.info("preLoadStatement: Success");
													preLoad = "Success: " + statement ;
												}
											}) ;
										}
										// Run Load statement
										console.info("Execute load statement: " + copyCommand) ;
										var statements = [
											"ALTER SESSION SET UDPARAMETER FOR awslib aws_id='" + process.env.aws_id + "'\n",
											"ALTER SESSION SET UDPARAMETER FOR awslib aws_secret='" + process.env.aws_secret + "'\n",
											"ALTER SESSION SET UDPARAMETER FOR awslib aws_region='" + process.env.aws_region + "'\n",
											copyCommand + "\n"
                    ];

										exports.chainStatements(client, statements, function(err, result) {
											// handle errors and cleanup
											if (err) {
												console.error("Load: Failed");
                                                                                                load = "Failed: " + copyCommand ;
												callback(null, {
													status : ERROR,
													error : err,
													preLoadStmt : preLoad,
													loadStmt : load,
													postLoadStmt : postLoad,
													cluster : clusterInfo.clusterEndpoint
												});
												client.disconnect();
											} else {
												console.info("Load: Success");
                                                                                                load = "Success: " + copyCommand ;
												// Run postLoad Statement, if defined
												if (clusterInfo.postLoadStatement !== undefined) {
													var statement = clusterInfo.postLoadStatement;
													console.info("Execute postLoadStatement: " + statement) ;
													client.query(statement, function(err) {
														if (err) {
															console.error("postLoadStatement: Failed");
                                                                                                        		postLoad = "Failed: " + statement ;
															callback(null, {
																status : ERROR,
			                                                                                                        error : err,
																preLoadStmt : preLoad,
																loadStmt : load,
																postLoadStmt : postLoad,
                                                                                                        			cluster : clusterInfo.clusterEndpoint
															});
														} else {
															console.info("postLoadStatement: Success");
                                                                                                        		postLoad = "Success: " + statement ;
															callback(null, {
																status : OK,
																error : null,
																preLoadStmt : preLoad,
																loadStmt : load,
																postLoadStmt : postLoad,
																cluster : clusterInfo.clusterEndpoint
															});
														}
														client.disconnect();
													}) ;
												} else {
													callback(null, {
														status : OK,
														error : null,
														preLoadStmt : preLoad,
														loadStmt : load,
														postLoadStmt : postLoad,
														cluster : clusterInfo.clusterEndpoint
													});
													client.disconnect();
												}
											}
										});
									}
								});
							}
						});
					};

			/**
			 * Function which marks a batch as failed and sends notifications
			 * accordingly
			 * Original version handled failed manifest copies - this code has bene removed, so function is no a no-op.
			 */
			exports.failBatch = function(loadState, config, thisBatchId, s3Info, loadStatements) {
				console.error('Batch failed.');
				exports.closeBatch(loadState, config, thisBatchId, s3Info, loadStatements);
				};

			/**
			 * Function which closes the batch to mark it as done, including
			 * notifications
			 */
			exports.closeBatch = function(batchError, config, thisBatchId, s3Info, loadStatements) {
				var batchEndStatus;

				if (batchError) {
					batchEndStatus = error;
				} else {
					batchEndStatus = complete;
				}

        var item = {
          batchid: thisBatchId,
          s3prefix: s3Info.prefix,
          status: batchEndStatus,
          lastupdate: common.now()
        };

				// add the error message to the updates if we had one
				if (batchError) {
					item.errormessage = JSON.stringify(batchError);
				}

				// mark the batch as closed
				Persistence.closeBatch(postgresClient, item, function(err) {
					// ugh, the batch closure didn't finish - this is not a good
					// place to be
					if (err) {
						console.error(err);
						done(context, error, err);
					} else {
						// send notifications
						exports.notify(config, thisBatchId, s3Info, batchError, loadStatements);
					}
				});
			};

			/** send an SNS message to a topic */
			exports.sendSNS = function(topic, subj, msg, successCallback, failureCallback) {
				var m = {
					Message : JSON.stringify(msg),
					Subject : subj,
					TopicArn : topic
				};

				sns.publish(m, function(err) {
					if (err) {
						if (failureCallback) {
							failureCallback(err);
						} else {
							console.error(err);
						}
					} else {
						if (successCallback) {
							successCallback();
						}
					}
				});
			};

			/** Send SNS notifications if configured for OK vs Failed status */
			exports.notify =
					function(config, thisBatchId, s3Info, batchError, loadStatements) {
						var statusMessage = batchError ? 'error' : 'ok';
						var errormessage = batchError ? JSON.stringify(batchError) : null;
						var messageBody = {
							error : errormessage,
							status : statusMessage,
							batchid : thisBatchId,
							s3prefix : s3Info.prefix
						};

						if (loadStatements) {
							messageBody.loadStatements = loadStatements
						}

						if (batchError) {
							console.error(JSON.stringify(batchError));

							if (config.failuretopicarn) {
								exports.sendSNS(config.failuretopicarn, "Lambda Vertica Batch Load " + thisBatchId + " Failure",
										messageBody, function() {
											done(context, error, JSON.stringify(batchError));
										}, function(err) {
											console.error(err);
											done(context, error, err);
										});
							} else {
								done(context, error, batchError);
							}
						} else {
							if (config.successtopicarn) {
								exports.sendSNS(config.successtopicarn, "Lambda Vertica Batch Load " + thisBatchId + " OK",
										messageBody, function() {
											done(context, null, null);
										}, function(err) {
											console.error(err);
											done(context, error, err);
										});
							} else {
								// finished OK - no SNS notifications for
								// success
								console.info("Batch Load " + thisBatchId + " Complete");
								done(context, null, null);
							}
						}
					};
			/* end of runtime functions */

			// commented out event logger, for debugging if needed
			// console.log(JSON.stringify(event));
					
			if (!event.Records) {
				// filter out unsupported events
				console.error("Event type unsupported by Lambda Vertica Loader");
				console.error(JSON.stringify(event));
				done(context, null, null);
			} else {
				if (event.Records.length > 1) {
					done(context, error, "Unable to process multi-record events");
				} else {
					for (var i = 0; i < event.Records.length; i++) {
						var r = event.Records[i];

						// ensure that we can process this event based on a variety
						// of criteria
						var noProcessReason = undefined;
						if (r.eventSource !== "aws:s3") {
							noProcessReason = "Invalid Event Source " + r.eventSource;
						}
						if (!(r.eventName === "ObjectCreated:Copy" || r.eventName === "ObjectCreated:Put" || r.eventName === 'ObjectCreated:CompleteMultipartUpload')) {
							noProcessReason = "Invalid Event Name " + r.eventName;
						}
						if (r.s3.s3SchemaVersion !== "1.0") {
							noProcessReason = "Unknown S3 Schema Version " + r.s3.s3SchemaVersion;
						}

						if (noProcessReason) {
							console.error(noProcessReason);
							done(context, error, noProcessReason);
						} else {
							// extract the s3 details from the event
							var inputInfo = {
								bucket : undefined,
								key : undefined,
								prefix : undefined,
								inputFilename : undefined
							};

							console.info("Opening connection to Postgres DB");
							postgresClient = require('./db/postgresConnector').connect();

							inputInfo.bucket = r.s3.bucket.name;
							inputInfo.key = decodeURIComponent(r.s3.object.key);

							// remove the bucket name from the key, if we have
							// received it
							// - happens on object copy
							inputInfo.key = inputInfo.key.replace(inputInfo.bucket + "/", "");

							var keyComponents = inputInfo.key.split('/');
							inputInfo.inputFilename = keyComponents[keyComponents.length - 1];

							// remove the filename from the prefix value
							var searchKey = inputInfo.key.replace(inputInfo.inputFilename, '').replace(/\/$/, '');

							// if the event didn't have a prefix, and is just in the
							// bucket, then just use the bucket name, otherwise add the prefix
							if (searchKey && searchKey !== "") {
								var regex = /(=\d+)+/;
								// transform hive style dynamic prefixes into static
								// match prefixes
								do {
									searchKey = searchKey.replace(regex, "=*");
								} while (searchKey.match(regex) !== null);

								searchKey = "/" + searchKey;
							}
							inputInfo.prefix = inputInfo.bucket + searchKey;

							var proceed = false;
							var lookupConfigTries = 10;
							var tryNumber = 0;
							var configData = null;

							async.whilst(function() {
								// return OK if the proceed flag has been set, or if
								// we've hit the retry count
								return !proceed && tryNumber < lookupConfigTries;
							}, function(callback) {
								tryNumber++;

								// lookup the configuration item, and run
								// foundConfig on completion
								Persistence.getConfig(postgresClient, inputInfo.prefix, function(err, data) {
									if (err) {
										callback(err);
									} else {
										configData = data;
										proceed = true;
										callback(null);
									}
								});
							}, function(err) {
								if (err) {
									// fail the context as we haven't been able to
									// lookup the onfiguration
									console.error(err);
									done(context, error, err);
								} else {
									// call the foundConfig method with the data item
									exports.foundConfig(inputInfo, null, configData);
								}
							});
						}
					}
				}
			}
		};
