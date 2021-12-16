/* eslint-disable no-restricted-globals */
/* global importScripts */
/* global SparkMD5 */
importScripts("spark-md5.min.js"); // 导入脚本

// 生成文件 hash
onmessage = e => {
  const { slices } = e.data

  // 创建
  const spark = new SparkMD5.ArrayBuffer()
  let percentage = 0
  let count = 0
  const loadNext = index => {
    const reader = new FileReader()
    reader.readAsArrayBuffer(slices[index])
    reader.onload = event => {
      count++
      // 利用 spark-md5 对文件内容进行计算得到 hash 值
      spark.append(event.target.result)
      if (count === slices.length) {
        postMessage({
          percentage: 100,
          hash: spark.end()
        })
        // 关闭 worker
        self.close()
      } else {
        percentage += 100 / slices.length
        self.postMessage({ progress: parseInt(percentage) })
        // 递归计算下一个切片
        loadNext(count)
      }
    }
  }
  loadNext(0) // 开启第一个切片的 hash 计算
}