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


var aws = require('aws-sdk');
require('./constants');
var common = require('./common');

var usage = function() {
	console.log("You must provide an AWS Region Code, Batch ID, and configured Input Location to use Unlock.");
	process.exit(ERROR);
};

if (process.argv.length < 4) {
	usage();
}

var setRegion = process.argv[2];
var thisBatchId = process.argv[3];
var prefix = process.argv[4];

if (!thisBatchId || !prefix) {
	usage();
}

// connect to PostgreSQL
var Persistence = require('./db/persistence');
var postgresClient = require('./db/postgresConnector').connect();

function exit(code) {
  postgresClient.end();
  process.exit(code);
}

Persistence.getConfig(postgresClient, prefix, function(err, data) {
	if (err) {
		console.log(err);
		exit(ERROR);
	} else {
		if (!data) {
			console.log("Unable to find Configuration with S3 Prefix " + prefix + " in Region " + setRegion);
			exit(ERROR);
		} else {
			// only allow unlocking if the batch is allocated as current
			if (data.currentbatch !== thisBatchId) {
				console.log("Batch " + thisBatchId + " is not currently allocated as the open batch for Load Configuration on "
						+ prefix + ". Use reprocessBatch.js to rerun the load of this Batch.");
				exit(ERROR);
			} else {
				var updateBatchStatus = {
					batchid : thisBatchId,
					s3prefix : prefix,
					status : 'open',
					lastupdate :  common.now()
				};

				Persistence.unlockBatch(postgresClient, updateBatchStatus, function(err) {
					if (err) {
						if (err.code === conditionCheckFailed) {
							console.log("Batch " + thisBatchId + " cannot be unlocked as it is not in 'locked' or 'error' status");
						} else {
							console.log(err);
							exit(ERROR);
						}
					} else {
						console.log("Batch " + thisBatchId + " Unlocked and ready for reprocessing");
					}

					exit(OK);
				});
			}
		}
	}
});
