import express from 'express';
import * as abciAppIdpApi from '../main/idp';
import * as abciAppCommonApi from '../main/common';

import validate from './validator';

const router = express.Router();

router.get('/callback', async (req, res, next) => {
  try {
    const url = abciAppIdpApi.getCallbackUrl();

    res.status(200).send({ url });
  } catch (error) {
    res.status(500).end();
  }
});

router.post('/callback', async (req, res, next) => {
  try {
    const { url } = req.body;

    const validationResult = validate({
      method: req.method,
      path: `${req.baseUrl}${req.route.path}`,
      body: req.body,
    });
    if (!validationResult.valid) {
      res.status(400).send(validationResult);
      return;
    }

    abciAppIdpApi.setCallbackUrl(url);

    res.status(200).end();
  } catch (error) {
    res.status(500).end();
  }
});

router.post('/response', async (req, res, next) => {
  try {
    const {
      status,
      request_id,
      namespace,
      identifier,
      secret,
      ial,
      aal,
      signature,
      accessor_id,
    } = req.body;

    let isSuccess = await abciAppIdpApi.createIdpResponse(req.body);

    res.status(200).send(isSuccess);
  } catch (error) {
    res.status(500).end();
  }
});

export default router;