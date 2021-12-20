import React, { useState, useMemo, useRef } from 'react';
import { Row, Col, Button, Input, Progress, List, message, Divider, Card } from 'antd';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

import 'antd/dist/antd.css';
import './App.css';

const md5WASM = require('./md5-wasm');

interface IChunk {
  // 切片源文件
  chunk: Blob;
  // hash值，用来标识文件的唯一性
  hash: string;
  // 文件名
  fileName: string;
  // 请求进度
  progress: number;
  // 下标，标记哪些分片包已上传完成
  index: number;
  // abort上传请求
  cancel: () => void;
}

// 切片大小，先定为5M
const SLICE_SIZE = 10 * 1024 * 1024;

const upload = (param: FormData, confg: AxiosRequestConfig) => axios.post('http://10.10.121.150:3001/upload', param, confg);

interface IMergeParams {
  fileName: string;
  hash: string;
  size: number;
}
const merge = (param: IMergeParams) => axios.post('http://10.10.121.150:3001/merge', param);

interface ICheckParams {
  fileName: string;
  hash: string;
}

interface ICheckRes {
  fileExist: boolean;
  uploadedChunks: string [];
}
const check = (params: ICheckParams) => axios.post<ICheckRes>('http://10.10.121.150:3001/check', params);

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [chunkList, setChunkList] = useState<IChunk[]>([]);
  const [uploadedChunk, setUploadedChunk] = useState<string[]>([]);
  const [uploadXhrList, setUploadXhrList] = useState<any[]>([]);

  const [hashProgress, setHashProgress] = useState<number>(0);

  const hash = useRef<string>('');
  const worker = useRef<Worker>();

  const percent = useMemo(() => {
    if (!file || !chunkList.length) return 0
    const loaded = chunkList.map(item => item.progress * item.chunk.size).reduce((sum, next) => sum + next)
    return parseInt((loaded / file.size).toFixed(2))
  }, [file, chunkList])

  const handleChangeFile = async (e: React.ChangeEvent<HTMLInputElement> | undefined) => {
    const file = e?.target?.files?.[0] || null;
    if (file) {
      setFile(file);
      const slices = createFileSlices(file);
      console.time("hash计算时间")
      const hashData = await calculateFileHash(slices);
      // const hashData = await calculateFileHashWasm(file);
      console.timeEnd("hash计算时间")
      hash.current = hashData;
      const res = await check({ fileName: file.name, hash: hashData });

      if (res.data.fileExist) {
        message.info("文件已上传")
        return;
      }

      const chunks = createFileChunks(file, slices);
      const uploadedChunkNameList = res.data.uploadedChunks;

      setChunkList(chunks);
      setUploadedChunk(uploadedChunkNameList);
      await uploadFileChunks(chunks, uploadedChunkNameList);
      merge({
        fileName: file.name,
        hash: hashData,
        size: SLICE_SIZE
      })
    }
  };

  // 文件切片
  const createFileSlices: (file: File) => Blob[] = (file) => {
    if (!file) return [];

    const slices = [];
    let start = 0;
    while (start < file.size) {
      const slice = file.slice(start, start + SLICE_SIZE)
      slices.push(slice)
      start += SLICE_SIZE
    }

    return slices;
  };

  // 组装切片包
  const createFileChunks: (file: File, slices: Blob[]) => IChunk[] = (file, slices) => {
    if (!slices?.length) return [];

    return slices.map((slice, index) => ({
      index,
      chunk: slice,
      hash: hash.current + '-' + index,
      fileName: file.name,
      progress: 0,
      cancel: () => { }
    }));
  };

  // 上传分片包
  const uploadFileChunks: (chunks: IChunk[], upLoadedChunks: string[]) => Promise<AxiosResponse<any, any>[]> | undefined = (chunks, upLoadedChunks) => {
    if (!chunks?.length) return;

    const requests = chunks.filter(({ hash }) => !upLoadedChunks.includes(hash)).map((item) => {
      const { chunk, hash, fileName, index } = item;
      const data = new FormData();
      data.append('chunk', chunk)
      data.append('hash', hash)
      data.append('fileName', fileName)

      const cancelToken = createCancelAction(item);
      const onUploadProgress = createProgressHandler(index)

      return upload(data, {
        onUploadProgress,
        cancelToken
      });
    })

    return Promise.all(requests)
  };

  // 创建每个chunk上传的progress监听函数
  const createProgressHandler = (index: number) => {
    return (e: any) => {
      setChunkList(prev => {
        const newList = prev.concat([])
        const chunk = newList.find(item => item.index === index);
        if (chunk) {
          chunk.progress = parseInt(String(e.loaded / e.total * 100));
        }

        return newList;
      });
    }
  };

  // 计算文件hash值
  const calculateFileHash: (slices: Blob[]) => Promise<string> = (slices) => {
    return new Promise((resolve, reject) => {
      // 添加 worker
      try {
        worker.current = new Worker('./hash.js')
        worker.current.postMessage({ slices })
        worker.current.onmessage = e => {
          const { hash, progress } = e.data
          setHashProgress(progress);
          if (hash) {
            resolve(hash)
          }
        }
      } catch (e) {
        reject(e)
      }
    })
  };
  
  // wasm计算文件hash值
  const calculateFileHashWasm: (file: File) => Promise<string> = (file) => {
    return new Promise((resolve, reject) => {
      try {
        const reader = new FileReader()
        reader.readAsArrayBuffer(file)
        reader.onload = (event: any) => {
          const buffer = event.target.result;
          md5WASM(buffer).then((res: string) => {
            resolve(res);
          }).catch(() => {
            reject();
          });
        }
      } catch (e) {
        reject(e)
      }
    })
  };

  // 获取cancelToken
  const createCancelAction = (chunk: IChunk) => {
    const { cancel, token }=  axios.CancelToken.source();
    chunk.cancel = cancel;
    return token;
  };

  // 暂停上传
  const handlePauseUpload = () => {
    // axios的cancel在调用abort前会判断请求是否存在，所以针对所有的请求直接调用cancel即可
    chunkList.forEach(chunk => chunk.cancel())
  };

  // 恢复上传
  const handleResumeUpload = async () => {
    await uploadFileChunks(chunkList, uploadedChunk);
    merge({
      fileName: file?.name || '',
      hash: hash.current,
      size: SLICE_SIZE
    })
  };

  return (
    <div className="App">
      <h1>大文件上传</h1>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Input type="file" onChange={handleChangeFile} /></Col>
        <Col><Button size="middle" style={{ height: 38 }} onClick={handlePauseUpload}>暂停上传</Button></Col>
        <Col><Button size="middle" style={{ height: 38 }} onClick={handleResumeUpload}>恢复上传</Button></Col>
      </Row>

      <h2>{ hash.current ? `hash值为：${hash.current}` : `hash计算进度` }</h2>
      <Row style={{ marginBottom: 16 }}>
        <Progress
          percent={hashProgress}
        />
      </Row>

      <h2>上传列表</h2>
      <Row gutter={32} className="row">
        <Col span={12}>
          <Card title="分片列表进度" bordered={false} style={{ width: '100%' }}>
            <List
              className="list"
              bordered
              dataSource={chunkList}
              renderItem={item => {
                const { progress, hash } = item;
                return <List.Item>
                  {hash}
                  <Progress
                    percent={progress}
                  />
                </List.Item>
              }}
            />
          </Card>
        </Col>

        <Col span={12}>
          <Card title="上传进度" bordered={false} style={{ width: '100%' }}>
            <Progress
              type="circle"
              percent={percent}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

export default App;
