/**
 * Copyright (c) 2018, 2019 National Digital ID COMPANY LIMITED
 *
 * This file is part of NDID software.
 *
 * NDID is the free software: you can redistribute it and/or modify it under
 * the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or any later
 * version.
 *
 * NDID is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Affero GNU General Public License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with the NDID source code. If not, see https://www.gnu.org/licenses/agpl.txt.
 *
 * Please contact info@ndid.co.th for any further questions
 *
 */

import { callbackUrls, processRequest } from '.';
import { invalidateDataSchemaCache } from './data_validator';

import CustomError from '../../error/custom_error';
import logger from '../../logger';

import * as tendermint from '../../tendermint';
import * as tendermintNdid from '../../tendermint/ndid';
import * as common from '../common';
import * as cacheDb from '../../db/cache';
import privateMessageType from '../private_message_type';

import * as config from '../../config';

const requestIdLocks = {};

export async function handleMessageFromQueue(message, nodeId = config.nodeId) {
  logger.info({
    message: 'Received message from MQ',
    nodeId,
  });
  logger.debug({
    message: 'Message from MQ',
    messageJSON: message,
  });

  const requestId = message.request_id;
  try {
    if (message.type === privateMessageType.DATA_REQUEST) {
      await cacheDb.setInitialSalt(
        nodeId,
        message.request_id,
        message.initial_salt
      );
      const latestBlockHeight = tendermint.latestBlockHeight;
      if (latestBlockHeight <= message.height) {
        logger.debug({
          message: 'Saving message from MQ',
          tendermintLatestBlockHeight: latestBlockHeight,
          messageBlockHeight: message.height,
        });
        requestIdLocks[nodeId + ':' + message.request_id] = true;
        await Promise.all([
          cacheDb.setRequestReceivedFromMQ(nodeId, message.request_id, message),
          cacheDb.addRequestIdExpectedInBlock(
            nodeId,
            message.height,
            message.request_id
          ),
        ]);
        if (tendermint.latestBlockHeight <= message.height) {
          delete requestIdLocks[nodeId + ':' + message.request_id];
          return;
        } else {
          await cacheDb.removeRequestReceivedFromMQ(nodeId, requestId);
        }
      }

      await processRequest(nodeId, message);
      delete requestIdLocks[nodeId + ':' + message.request_id];
    }
  } catch (error) {
    const err = new CustomError({
      message: 'Error handling message from message queue',
      cause: error,
    });
    logger.error(err.getInfoForLog());
    await common.notifyError({
      nodeId,
      callbackUrl: callbackUrls.error_url,
      action: 'handleMessageFromQueue',
      error: err,
      requestId,
    });
  }
}

export async function handleTendermintNewBlock(
  fromHeight,
  toHeight,
  parsedTransactionsInBlocks,
  nodeId = config.nodeId
) {
  logger.debug({
    message: 'Handling Tendermint new blocks',
    nodeId,
    fromHeight,
    toHeight,
  });
  try {
    await Promise.all([
      processRequestExpectedInBlocks(fromHeight, toHeight, nodeId),
      processTasksInBlocks(parsedTransactionsInBlocks, nodeId),
    ]);
  } catch (error) {
    const err = new CustomError({
      message: 'Error handling Tendermint NewBlock event',
      cause: error,
    });
    logger.error(err.getInfoForLog());
    await common.notifyError({
      nodeId,
      callbackUrl: callbackUrls.error_url,
      action: 'handleTendermintNewBlock',
      error: err,
    });
  }
}

async function processRequestExpectedInBlocks(fromHeight, toHeight, nodeId) {
  const requestIdsInTendermintBlock = await cacheDb.getRequestIdsExpectedInBlock(
    nodeId,
    fromHeight,
    toHeight
  );
  await Promise.all(
    requestIdsInTendermintBlock.map(async (requestId) => {
      if (requestIdLocks[nodeId + ':' + requestId]) return;
      const request = await cacheDb.getRequestReceivedFromMQ(nodeId, requestId);
      if (request == null) return;
      await processRequest(nodeId, request);
      await cacheDb.removeRequestReceivedFromMQ(nodeId, requestId);
    })
  );
  cacheDb.removeRequestIdsExpectedInBlock(nodeId, fromHeight, toHeight);
}

async function processTasksInBlocks(parsedTransactionsInBlocks, nodeId) {
  const transactionsInBlocksToProcess = parsedTransactionsInBlocks.filter(
    ({ transactions }) => transactions.length >= 0
  );

  await Promise.all(
    transactionsInBlocksToProcess.map(async ({ transactions }) => {
      const requestIdsToCleanUpSet = new Set();

      transactions.forEach((transaction) => {
        const requestId = transaction.args.request_id;
        if (requestId != null) {
          if (
            transaction.fnName === 'CloseRequest' ||
            transaction.fnName === 'TimeOutRequest'
          ) {
            requestIdsToCleanUpSet.add(requestId);
          }
        }

        if (transaction.fnName === 'UpdateService') {
          invalidateDataSchemaCache(transaction.args.service_id);
        }
      });

      // Clean up closed or timed out create identity requests
      const requestIdsToCleanUp = [...requestIdsToCleanUpSet];

      await Promise.all(
        requestIdsToCleanUp.map(async (requestId) => {
          // Clean up when request is timed out or closed before AS response
          const initialSalt = await cacheDb.getInitialSalt(nodeId, requestId);
          if (initialSalt != null) {
            const requestDetail = await tendermintNdid.getRequestDetail({
              requestId,
            });
            const serviceIds = requestDetail.data_request_list.map(
              (dataRequest) => dataRequest.service_id
            );
            await Promise.all([
              ...serviceIds.map(async (serviceId) => {
                const dataRequestId = requestId + ':' + serviceId;
                await cacheDb.removeRpIdFromDataRequestId(
                  nodeId,
                  dataRequestId
                );
              }),
              cacheDb.removeInitialSalt(nodeId, requestId),
            ]);
          }
        })
      );
    })
  );
}
