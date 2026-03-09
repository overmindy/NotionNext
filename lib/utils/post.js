/**
 * 文章相关工具
 * 此处只能放客户端支持的代码
 */
import BLOG from '@/blog.config'
import { isHttpLink } from '.'
import { siteConfig } from '@/lib/config'
import { uploadDataToAlgolia } from '../plugins/algolia'
import { getPageContentText } from '@/lib/db/notion/getPageContentText'
import { getPageTableOfContents } from '../db/notion/getPageTableOfContents'
import { countWords } from '../plugins/wordCount'
import md5 from 'js-md5'
import { getTextContent } from 'notion-utils'

import CryptoJS from 'crypto-js'

/**
 * 获取文章的关联推荐文章列表，目前根据标签关联性筛选
 * @param post
 * @param {*} allPosts
 * @param {*} count
 * @returns
 */
export function getRecommendPost(post, allPosts, count = 6) {
  let recommendPosts = []
  const postIds = []
  const currentTags = post?.tags || []
  for (let i = 0; i < allPosts.length; i++) {
    const p = allPosts[i]
    if (p.id === post.id || p.type.indexOf('Post') < 0) {
      continue
    }

    for (let j = 0; j < currentTags.length; j++) {
      const t = currentTags[j]
      if (postIds.indexOf(p.id) > -1) {
        continue
      }
      if (p.tags && p.tags.indexOf(t) > -1) {
        recommendPosts.push(p)
        postIds.push(p.id)
      }
    }
  }

  if (recommendPosts.length > count) {
    recommendPosts = recommendPosts.slice(0, count)
  }
  return recommendPosts
}

/**
 * 确认slug中不包含 / 符号
 * @param {*} row
 * @returns
 */
export function checkSlugHasNoSlash(row) {
  let slug = row.slug
  if (slug.startsWith('/')) {
    slug = slug.substring(1)
  }
  return (
    (slug.match(/\//g) || []).length === 0 &&
    !isHttpLink(slug) &&
    row.type.indexOf('Menu') < 0
  )
}

/**
 * 检查url中包含一个  /
 * @param {*} row
 * @returns
 */
export function checkSlugHasOneSlash(row) {
  let slug = row.slug
  if (slug.startsWith('/')) {
    slug = slug.substring(1)
  }
  return (
    (slug.match(/\//g) || []).length === 1 &&
    !isHttpLink(slug) &&
    row.type.indexOf('Menu') < 0
  )
}

/**
 * 检查url中包含两个及以上的  /
 * @param {*} row
 * @returns
 */
export function checkSlugHasMorThanTwoSlash(row) {
  let slug = row.slug
  if (slug.startsWith('/')) {
    slug = slug.substring(1)
  }
  return (
    (slug.match(/\//g) || []).length >= 2 &&
    row.type.indexOf('Menu') < 0 &&
    !isHttpLink(slug)
  )
}


/**
 * 获取文章摘要
 * @param props
 * @param pageContentText
 * @returns {Promise<void>}
 */
async function getPageAISummary(props, pageContentText) {
  const aiSummaryAPI = siteConfig('AI_SUMMARY_API')
  if (aiSummaryAPI) {
    const post = props.post
    const cacheKey = `ai_summary_${post.id}`
    let aiSummary = await getDataFromCache(cacheKey)
    if (aiSummary) {
      props.post.aiSummary = aiSummary
    } else {
      const aiSummaryKey = siteConfig('AI_SUMMARY_KEY')
      const aiSummaryCacheTime = siteConfig('AI_SUMMARY_CACHE_TIME')
      const wordLimit = siteConfig('AI_SUMMARY_WORD_LIMIT', '1000')
      let content = ''
      for (let heading of post.toc) {
        content += heading.text + ' '
      }
      content += pageContentText
      const combinedText = post.title + ' ' + content
      const truncatedText = combinedText.slice(0, wordLimit)
      aiSummary = await getAiSummary(aiSummaryAPI, aiSummaryKey, truncatedText)
      await setDataToCache(cacheKey, aiSummary, aiSummaryCacheTime)
      props.post.aiSummary = aiSummary
    }
  }
}

/**
 * 处理文章数据
 * @param props
 * @param from
 * @returns {Promise<void>}
 */
export async function processPostData(props, from) {

  if (props.post?.blockMap?.block) {
    if (props.post.password && props.post.password !== '') {
      cleanPasswordInBlockMap(props.post)
    }

    // 目录默认加载
    props.post.content = Object.keys(props.post.blockMap.block).filter(
      key => props.post.blockMap.block[key]?.value?.parent_id === props.post.id
    )
    props.post.toc = getPageTableOfContents(props.post, props.post.blockMap)
    const pageContentText = getPageContentText(props.post, props.post.blockMap)
    const { wordCount, readTime } = countWords(pageContentText)
    props.post.wordCount = wordCount
    props.post.readTime = readTime
    await getPageAISummary(props, pageContentText)

    if (props.post.password && props.post.password !== '') {
      const sensitiveData = {
        blockMap: props.post.blockMap,
        content: props.post.content,
        toc: props.post.toc
      }
      const jsonStr = JSON.stringify(sensitiveData)
      props.post.encryptedContent = CryptoJS.AES.encrypt(jsonStr, props.post.password).toString()
      
      // 清空原始的明文数据，防止泄露到前端
      delete props.post.blockMap
      delete props.post.content
      delete props.post.toc
    }
  }

  // 生成全文索引 && JSON.parse(BLOG.ALGOLIA_RECREATE_DATA)
  if (BLOG.ALGOLIA_APP_ID) {
    uploadDataToAlgolia(props?.post)
  }

  // 推荐关联文章处理
  const allPosts = props.allPages?.filter(
    page => page.type === 'Post' && page.status === 'Published'
  )
  if (allPosts && allPosts.length > 0) {
    const index = allPosts.indexOf(props.post)
    props.prev = allPosts.slice(index - 1, index)[0] ?? allPosts.slice(-1)[0]
    props.next = allPosts.slice(index + 1, index + 2)[0] ?? allPosts[0]
    props.recommendPosts = getRecommendPost(
      props.post,
      allPosts,
      siteConfig('POST_RECOMMEND_COUNT')
    )
  } else {
    props.prev = null
    props.next = null
    props.recommendPosts = []
  }

  delete props.allPages
}

/**
 * 清理块中的密码字段，防止前端源码中泄露
 * @param {*} post 
 */
export function cleanPasswordInBlockMap(post) {
  if (!post || !post.blockMap || !post.blockMap.block || !post.password) return

  const blockMap = post.blockMap
  const passwordPropName = BLOG.NOTION_PROPERTY_NAME?.password || 'password'
  let passwordSchemaKey = null

  // 1. 尝试通过 Schema 找到密码字段的 Key
  if (blockMap.collection) {
    for (const collectionId in blockMap.collection) {
      const schema = blockMap.collection[collectionId]?.value?.schema
      if (schema) {
        for (const key in schema) {
          if (schema[key]?.name === passwordPropName) {
            passwordSchemaKey = key
            delete schema[key] // 从 schema 中删除，防止react-notion-x渲染
            break
          }
        }
      }
      if (passwordSchemaKey) break
    }
  }

  // 2. 遍历所有 block，移除密码原文字段
  for (const blockId in blockMap.block) {
    const block = blockMap.block[blockId]
    if (block?.value?.properties) {
      if (passwordSchemaKey) {
        // 如果找到了 schema key，直接删除对应属性
        if (block.value.properties[passwordSchemaKey]) {
          delete block.value.properties[passwordSchemaKey]
        }
      } else {
        // 兜底方案：通过 md5 匹配原文（因为 post.password 是 md5(slug + password)）
        for (const key in block.value.properties) {
          const val = block.value.properties[key]
          const text = getTextContent(val)
          if (text && md5(post.slug + text) === post.password) {
            delete block.value.properties[key]
          }
        }
      }
    }
  }
}

