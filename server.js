const http = require('http')
const path = require('path')
const fs = require('fs')
const qs = require('qs')
// 用于处理body
const multiparty = require('multiparty')
const server = http.createServer()
// 服务端保存上传文件的目录
const FILES_DIR = path.resolve(__dirname, './upload')

// 处理body信息
// 处理json和test都比较简单，只需要监听 data end事件，然后拼接即可
const resolvePost = (req) => (
  new Promise((resolve) => {
    let chunk = []

    req.on('data', buff => {
      chunk.push(buff)
    })

    req.on('end', () => {
      let chunks = Buffer.concat(chunk);
      resolve(JSON.parse(chunks.toString()));
    })
  })
);

// 接收分片
const uploadFile = (req, res) => {
  const multipart = new multiparty.Form()
  multipart.parse(req, async(err, fields, files) => {
    if (err) {
      res.end(JSON.stringify({
        code: 500,
        mes: 'Upload Failed'
      }))
      throw err
    }

    const [chunk] = files.chunk;
    const [hash] = fields.hash;
    const [fileName] = fields.fileName;

    // 临时文件目录
    const tempDir = hash.split('-')[0];
    const chunkDir = path.resolve(FILES_DIR, tempDir)

    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir)
    }

    // chunk.path指的是经过multiparty处理之后的文件的存放处，将那个地址移动到我们需要的指定地址
    fs.copyFileSync(chunk.path, `${chunkDir}\\${hash}`)
    // 删除临时文件
    fs.rmSync(chunk.path)

    res.end(JSON.stringify({
      code: 0,
      mes: '上传完成'
    }))
  })
};

// 合并文件
const mergeFile = async (req, res) => {
  const { hash, fileName, size } = await resolvePost(req);
  const fileDir = path.resolve(FILES_DIR, hash.split('-')[0]);

  const fileNameList = fs.readdirSync(fileDir);
  // 按序读取文件
  const sortableFileNameList = fileNameList.sort((a, b) => a.split("-")[1] - b.split("-")[1])

  const fns = sortableFileNameList.map((tempFileName, index) => {
    const readPath = path.resolve(fileDir, tempFileName)
    const readStream = fs.createReadStream(readPath)
    // 因为是创建多个管道流，所以需要给每个写入流定位开始位置和结束位置
    const writeStream = fs.createWriteStream(path.resolve(FILES_DIR, fileName), {
      start: size * index,
      end: (index + 1) * size
    })
    readStream.pipe(writeStream)

    return new Promise((resolve, reject) => {
      readStream.on('close', () => {
        console.log('读取的文件路径为:' + readStream.path)
        resolve(true)
      })
    })
  });

  await Promise.all(fns).catch(e => {
    console.log(e)
  })
  
  fs.rmSync(fileDir, { recursive: true, force: true })

  res.end(JSON.stringify({
    code: 0,
    mes: '合并完成'
  }))
};

// 检查文件是否已上传
const checkCache = async (req, res) => {
  const { hash, fileName } = await resolvePost(req);

  // 先判断有没有文件
  const fileDir = path.resolve(FILES_DIR, fileName);
  if (fs.existsSync(fileDir)) {
    res.end(JSON.stringify({
      code: 0,
      fileExist: true
    }));
    return;
  }

  // 判断切片包文件夹是否存在
  const chunkDir = path.resolve(FILES_DIR, hash.split('-')[0]);
  let uploadedChunks = [];
  if (fs.existsSync(chunkDir)) {
    const fileDir = path.resolve(FILES_DIR, hash.split('-')[0]);
    uploadedChunks = fs.readdirSync(fileDir);
  }

  res.end(JSON.stringify({
    code: 0,
    fileExist: false,
    uploadedChunks
  }));
};

server.on('request', async (req, res) => {
  res.setHeader('Content-Type', "application/json;charset=utf-8")
  // 设置跨域
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-control-Allow-Headers', '*')
  res.setHeader('Access-control-Allow-Methods', '*')
  
  // 兼容post
  if(req.method === 'OPTIONS') {
    res.status = 200
    res.end()
    return
  }

  const { url } = req;
  switch(url) {
    case '/upload': uploadFile(req, res); break;
    case '/merge': mergeFile(req, res); break;
    case '/check': checkCache(req, res); break;
  }
})

server.listen(3001, () => console.log('running at 3001'))